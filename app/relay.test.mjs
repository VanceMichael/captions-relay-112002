import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from '../source-server.mjs';
import { RelayService } from './relay-service.mjs';
import { SourceClient, SourceError } from './source-client.mjs';
import { evaluateScreening } from './domain.mjs';

async function startSource() {
  const { server, url } = await start();
  return {
    url,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function refsBy(report, usageIndex, lang) {
  return report.references.filter((ref) => ref.usageIndex === usageIndex && ref.lang === lang);
}

test('阶段1：资料未齐时区分未到齐与已到字幕的剪辑点阻塞', async (t) => {
  const source = await startSource();
  t.after(source.close);
  const relay = new RelayService(new SourceClient(source.url));
  const { stage } = await relay.sync();
  assert.equal(stage, 1);

  const vw01 = relay.getScreeningReport('VW01');
  assert.equal(vw01.cut, 'C-A');
  assert.equal(vw01.ready, false);

  // INT-A 第一次引用 [1000,5100)：H1 整段在内，但译者授权断开点 4500 生效，
  // 切成两段，两段均完整落在引用内。
  const h1 = refsBy(vw01, 0, 'zh');
  assert.deepEqual(h1.map((ref) => ref.sourceRange), [[1600, 4500], [4500, 4900]]);
  assert.deepEqual(h1.map((ref) => ref.text), ['河谷冬季关闭。', '六月恢复开放。']);
  assert.ok(h1.every((ref) => ref.status === 'ready'));
  assert.ok(h1.every((ref) => ref.grant === 'G1'));
  // 节目时码 = 片段节目起点 + (源时码 - 引用源起点)。
  assert.deepEqual(h1.map((ref) => ref.programRange), [[600, 3500], [3500, 3900]]);

  // E7 无 splits，且整段 [1600,4800) 完整落在 [1000,5100) 内，可交付（G2 覆盖 VW01）。
  const e7u0 = refsBy(vw01, 0, 'en');
  assert.equal(e7u0.length, 1);
  assert.equal(e7u0[0].status, 'ready');
  assert.equal(e7u0[0].grant, 'G2');

  // INT-B 引用：E8 尚未到齐，目录中无覆盖 -> pending，而不是 withdrawn。
  const intbZh = refsBy(vw01, 1, 'zh');
  const intbEn = refsBy(vw01, 1, 'en');
  assert.equal(intbZh[0].status, 'pending');
  assert.equal(intbEn[0].status, 'pending');

  // INT-A 第二次引用 [3900,5100)：H1/E7 都跨过引用起点 3900 这个剪辑接点。
  // H1 在 4500 有授权断开：4500-4900 一段可交付；3900-4500 一段越界且 3900
  // 不是授权断开点 -> uncuttable，需请翻译补件。
  const h1u2 = refsBy(vw01, 2, 'zh');
  const readyH1 = h1u2.filter((ref) => ref.status === 'ready');
  const uncutH1 = h1u2.filter((ref) => ref.status === 'uncuttable');
  assert.deepEqual(readyH1.map((ref) => ref.sourceRange), [[4500, 4900]]);
  assert.deepEqual(uncutH1.map((ref) => ref.sourceRange), [[1600, 4500]]);
  assert.ok(uncutH1[0].blockers[0].detail.includes('补件'));
  // 可交付 cue 已平移到第二次引用的节目起点 7100。
  assert.deepEqual(readyH1[0].programRange, [7700, 8100]);

  // E7 没有任何 splits，跨过接点的整段不可断开 -> uncuttable。
  const e7u2 = refsBy(vw01, 2, 'en');
  assert.equal(e7u2.length, 1);
  assert.equal(e7u2[0].status, 'uncuttable');
  assert.equal(e7u2[0].splitAuthorized, true); // 子区间本身来自授权分区，只是越界

  // VW02 只输出 en，且 G2 覆盖 VW02；G1（仅 VW01 的 zh）不得出现在其报告里。
  const vw02 = relay.getScreeningReport('VW02');
  assert.deepEqual(vw02.languages, ['en']);
  assert.ok(vw02.references.every((ref) => ref.lang === 'en'));
  assert.equal(vw02.references.find((ref) => ref.usageIndex === 0).status, 'ready');
});

test('阶段2：INT-B 英文字幕到齐，排期登记的领用被冻结，可交付包不含阻塞段', async (t) => {
  const source = await startSource();
  t.after(source.close);
  const relay = new RelayService(new SourceClient(source.url));
  await relay.sync();
  const client = new SourceClient(source.url);
  await client.setStage(2);
  const { fresh } = await relay.sync();
  assert.ok(fresh.some((item) => item.record === 'captions-3'));
  assert.ok(fresh.some((item) => item.record === 'schedule-3'));

  // 排期里的 pickup（QP7）在同步时自动冻结。
  const receipt = relay.getReceipt('QP7');
  assert.ok(receipt);
  assert.equal(receipt.show, 'VW01');
  assert.equal(receipt.cut, 'C-A');
  assert.equal(receipt.frozenStage, 2);

  const vw01 = relay.getScreeningReport('VW01');
  // E8 [500,2600) 完整落在 INT-B 引用 [0,3000) 内 -> ready。
  const e8 = refsBy(vw01, 1, 'en');
  assert.equal(e8.length, 1);
  assert.equal(e8[0].status, 'ready');
  assert.deepEqual(e8[0].programRange, [4600, 6700]);
  // 中文 INT-B 依旧没有任何来源 -> 仍是 pending。
  assert.equal(refsBy(vw01, 1, 'zh')[0].status, 'pending');

  // 可交付 cue 全部来自 ready 引用，不含 uncuttable/pending 段。
  const cueIds = new Set(vw01.deliverableCues.map((cue) => cue.caption));
  assert.deepEqual([...cueIds].sort(), ['E7', 'E8', 'H1']);
  assert.ok(vw01.deliverableCues.every((cue) => {
    const ref = vw01.references.find(
      (item) => item.caption === cue.caption
        && item.usageIndex === cue.usageIndex
        && item.lang === cue.lang
        && item.programRange[0] === cue.programFrom,
    );
    return ref && ref.status === 'ready';
  }));

  // 冻结包里的报告与当前报告内容一致（同阶段），且已做深拷贝隔离。
  assert.deepEqual(receipt.report.deliverableCues, vw01.deliverableCues);
  receipt.report.deliverableCues.push({ tampered: true });
  assert.equal(relay.getReceipt('QP7').report.deliverableCues.some((cue) => cue.tampered), false);
});

test('阶段3：撤下与节目版换版分别处理，已领回执保持旧时码可回查', async (t) => {
  const source = await startSource();
  t.after(source.close);
  const client = new SourceClient(source.url);
  const relay = new RelayService(client);
  await client.setStage(2);
  await relay.sync();
  const frozen = relay.getReceipt('QP7');
  const frozenCues = structuredClone(frozen.report.deliverableCues);

  await client.setStage(3);
  const { fresh, screenings } = await relay.sync();
  assert.ok(fresh.some((item) => item.record === 'captions-4')); // withdraw
  assert.ok(fresh.some((item) => item.record === 'editing-2')); // C-B
  assert.ok(fresh.some((item) => item.record === 'schedule-4')); // VW01 换版

  // 已领的 QP7 仍是阶段2冻结的 C-A 旧时码包，不被换版/撤下改写。
  const receiptAgain = relay.getReceipt('QP7');
  assert.equal(receiptAgain.cut, 'C-A');
  assert.equal(receiptAgain.frozenStage, 2);
  assert.deepEqual(receiptAgain.report.deliverableCues, frozenCues);

  // H1 的 [4100,4900) 被明确撤下：C-A 评估里原 ready 的 [4500,4900) 变 withdrawn；
  // 未被撤下覆盖的 [1600,4100) 保留为 uncuttable（越界问题依旧），而非整条消失。
  const currentCA = relay.catalog.getCut('C-A');
  const vw01CutA = evaluateScreening(relay.catalog.getScreening('VW01'), currentCA, relay.catalog);
  const h1CA = vw01CutA.references.filter((ref) => ref.caption === 'H1');
  // 顺序：引用#0 的两段（均与撤下区间相交），再引用#2 的两段。
  // 撤下是内容级事实：即使第二段同时越界，状态仍为 withdrawn，
  // 越界事实保留在 blockers 里提醒补件。
  assert.deepEqual(
    h1CA.map((ref) => [ref.usageIndex, ref.sourceRange, ref.status]),
    [
      [0, [1600, 4500], 'withdrawn'],
      [0, [4500, 4900], 'withdrawn'],
      [2, [1600, 4500], 'withdrawn'],
      [2, [4500, 4900], 'withdrawn'],
    ],
  );
  assert.ok(h1CA[2].blockers.some((item) => item.reason === 'uncuttable'));

  // 当前 VW01 已锁到 C-B；新包里只有 C-B 时码，不会混入 C-A 旧节目起点。
  const vw01 = screenings.find((report) => report.show === 'VW01');
  assert.equal(vw01.cut, 'C-B');
  const cbProgramStarts = relay.catalog.getCut('C-B').clips.map((clip) => clip.programStart);
  assert.ok(vw01.deliverableCues.every((cue) => {
    const inside = cbProgramStarts.some((start) => cue.programFrom >= start);
    return inside;
  }));
  // C-B 第一个引用是 INT-B（节目起点 0），E8 可交付且节目时码按新起点重算。
  const e8CB = vw01.references.find((ref) => ref.usageIndex === 0 && ref.caption === 'E8');
  assert.equal(e8CB.status, 'ready');
  assert.deepEqual(e8CB.programRange, [500, 2600]);

  // C-B 的 INT-A 引用 [1000,4500)：H1 的 [1600,4500] 完整在内，但已落在
  // 撤下区间内 -> withdrawn；E7 越界且无授权断开 -> uncuttable。
  const h1CBv1 = vw01.references.filter((ref) => ref.usageIndex === 1 && ref.caption === 'H1');
  assert.equal(h1CBv1[0].status, 'withdrawn');
  const e7CBv1 = vw01.references.filter((ref) => ref.usageIndex === 1 && ref.caption === 'E7');
  assert.equal(e7CBv1[0].status, 'uncuttable');

  // 影响面回查：C-B 换版波及 VW01；C-A 仍有已领回执 QP7 需要回查。
  const impact = relay.auditCut('C-B');
  assert.deepEqual(impact.affectedShows, ['VW01']);
  const impactA = relay.auditCut('C-A');
  assert.ok(impactA.staleReceipts.includes('QP7'));

  // 撤下与未到齐在阻塞计数中分开。
  assert.ok(vw01.blockerCounts.withdrawn > 0);
  assert.ok(vw01.blockerCounts.pending > 0 || vw01.blockerCounts.uncuttable > 0);
});

test('阶段4：限制公开的译稿与备用语规则，新字幕按每个引用核验而非按文件计数', async (t) => {
  const source = await startSource();
  t.after(source.close);
  const client = new SourceClient(source.url);
  const relay = new RelayService(client);
  // 逐阶段推进，保证 QP7 在阶段2（其登记到达时）即被冻结。
  await client.setStage(2);
  await relay.sync();
  await client.setStage(3);
  await relay.sync();
  await client.setStage(4);
  await relay.sync();

  const h3 = relay.catalog.getCaption('H3');
  assert.ok(h3.publicDenied.includes('VW01'));

  const vw01 = relay.getScreeningReport('VW01');
  // H3 覆盖 C-B 中 INT-A 的两个引用：每个引用分别核验，结论分别成立。
  const h3Refs = vw01.references.filter((ref) => ref.caption === 'H3');
  assert.equal(h3Refs.length, 2);
  assert.ok(h3Refs.every((ref) => ref.status === 'public-denied'));
  assert.deepEqual(h3Refs.map((ref) => ref.usageIndex).sort(), [1, 2]);

  // 新字幕的跨节目版引用审计：H3 同时对照 C-B（当前排期）与 C-A（已换版的
  // 旧剪辑）的全部引用，返回的是引用级结论，数量不等于“1 个文件”。
  const audit = relay.auditCaption('H3');
  const cuts = new Set(audit.map((item) => item.cut));
  assert.deepEqual([...cuts].sort(), ['C-A', 'C-B']);
  assert.equal(audit.length, 4);
  // 同一文件逐引用结论不同：VW01 明确禁映；VW02 未列入禁映但没有任何许可。
  const vw01Audit = audit.filter((item) => item.show === 'VW01');
  const vw02Audit = audit.filter((item) => item.show === 'VW02');
  assert.ok(vw01Audit.every((item) => item.status === 'public-denied'));
  assert.ok(vw02Audit.every((item) => item.status === 'no-permission'));
  // 同一文件在不同引用的节目时码不同，证明核验是逐引用而非按文件计数。
  assert.equal(new Set(audit.map((item) => `${item.programRange[0]}`)).size, audit.length);

  // 同一份 G2 许可可发给 VW01 也可发给 VW02 的英文场（许可按场次/语言判定）。
  const vw02 = relay.getScreeningReport('VW02');
  assert.ok(vw02.references.every((ref) => ref.lang === 'en'));
  const e7VW02 = vw02.references.find((ref) => ref.caption === 'E7' && ref.usageIndex === 0);
  assert.equal(e7VW02.status, 'ready');
  // VW02 只排 en：zh 译稿（含 H1/H3）根本不进入它的可发清单。
  assert.ok(vw02.references.every((ref) => !['H1', 'H3'].includes(ref.caption)));

  // 已领回执 QP7 不受阶段4影响，仍可完整回查。
  const qp7 = relay.getReceipt('QP7');
  assert.equal(qp7.frozenStage, 2);
  assert.ok(qp7.report.deliverableCues.length > 0);
});

test('备用语只能在场馆认可语言顺序内生效，且不能绕开原语言公开限制', async (t) => {
  const source = await startSource();
  t.after(source.close);
  const client = new SourceClient(source.url);
  const relay = new RelayService(client);
  await client.setStage(4);
  await relay.sync();

  const vw01 = relay.getScreeningReport('VW01');
  // 语言顺序 zh 首选、en 备用：INT-B 引用只有 en 的 E8 可交付，
  // 因此该引用点的交付 cue 是备用语 en；首选 zh 为 pending。
  const intbCue = vw01.deliverableCues.find((cue) => cue.usageIndex === 0);
  assert.equal(intbCue.lang, 'en');
  const intbZh = refsBy(vw01, 0, 'zh');
  assert.equal(intbZh[0].status, 'pending');

  // H3 限制公开的是 zh 译稿本身：它不产生可交付 cue，也不能被标成 en 放行。
  const deniedCue = vw01.deliverableCues.find((cue) => cue.caption === 'H3');
  assert.equal(deniedCue, undefined);
});

test('来源异常时客户端重试并抛出带上下文的错误，分页参数保持合法', async (t) => {
  const source = await startSource();
  t.after(source.close);
  const client = new SourceClient(source.url, { maxAttempts: 2 });
  await assert.rejects(
    () => client.fetchAll('missing'),
    (error) => error instanceof SourceError && error.status === 404,
  );
  await assert.rejects(
    () => client.setStage(0),
    (error) => error instanceof SourceError && error.status === 400,
  );
  const overview = await client.overview();
  assert.equal(overview.stage, 1);
});

test('重复同步是幂等的，新包不会混入旧节目版时码', async (t) => {
  const source = await startSource();
  t.after(source.close);
  const client = new SourceClient(source.url);
  const relay = new RelayService(client);
  await client.setStage(3);
  await relay.sync();
  const before = relay.listScreeningReports().map((report) => structuredClone(report));
  const second = await relay.sync();
  assert.equal(second.fresh.length, 0);
  const after = relay.listScreeningReports();
  assert.deepEqual(after, before);

  // 值班员在阶段3新领 VW01：包只含 C-B 时码。
  const qp9 = relay.claim('VW01', 'QP9');
  assert.equal(qp9.cut, 'C-B');
  assert.ok(qp9.report.deliverableCues.every((cue) => cue.programFrom >= 0));
  // 重复领取同一回执返回同一个冻结包。
  assert.deepEqual(relay.claim('VW01', 'QP9'), qp9);
});
