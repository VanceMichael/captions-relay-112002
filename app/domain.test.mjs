import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog } from './catalog.mjs';
import { buildCaptionSegments, evaluateScreening } from './domain.mjs';

// 构造一个只暴露评估所需接口的目录桩。
function stubCatalog({ captions = [], grants = [] }) {
  const catalog = new Catalog();
  for (const grant of grants) {
    catalog.ingestRecord('captions', {
      record: `grant-${grant.id}`,
      availableFrom: 1,
      kind: 'grant',
      payload: grant,
    }, 1);
  }
  captions.forEach((caption, index) => {
    catalog.ingestRecord('captions', {
      record: `cap-${index}`,
      availableFrom: 1,
      kind: 'caption',
      payload: { splits: [], ...caption },
    }, 1);
  });
  return catalog;
}

const screening = {
  show: 'S1',
  site: '谷馆',
  cut: 'C1',
  languages: ['zh', 'en'],
  time: '10:00',
};
const cut = {
  cut: 'C1',
  clips: [
    { clip: 'INT-X', source: [0, 3000], programStart: 0, usageIndex: 0 },
    { clip: 'INT-X', source: [3000, 8000], programStart: 3000, usageIndex: 1 },
  ],
};

test('cutOnly 字幕按节目毫秒判定，不随片段源起点平移', () => {
  const catalog = stubCatalog({
    captions: [{
      id: 'CO1', lang: 'zh', clip: 'INT-X', from: 1000, to: 3000,
      text: '馆内解说', cutOnly: { cut: 'C1', from: 1000, to: 3000 }, grant: 'G1',
    }],
    grants: [{ id: 'G1', shows: ['S1'], lang: 'zh' }],
  });
  const report = evaluateScreening(screening, cut, catalog);
  const refs = report.references.filter((ref) => ref.caption === 'CO1');
  // 节目区间 [1000,3000) 完整落在第一个引用的节目区间 [0,4000) 内。
  assert.equal(refs.length, 1);
  assert.equal(refs[0].usageIndex, 0);
  assert.equal(refs[0].status, 'ready');
  assert.deepEqual(refs[0].programRange, [1000, 3000]);
  assert.equal(refs[0].sourceRange, null);
});

test('许可按场次与最终语言判定：同片段字幕可适用一场却不能发另一场', () => {
  const catalog = stubCatalog({
    captions: [{
      id: 'Z1', lang: 'zh', clip: 'INT-X', from: 100, to: 2900,
      text: '可放映', grant: 'G1',
    }],
    grants: [{ id: 'G1', shows: ['S1'], lang: 'zh' }],
  });
  const s1 = evaluateScreening(screening, cut, catalog);
  assert.equal(s1.references.find((ref) => ref.caption === 'Z1').status, 'ready');

  const other = { ...screening, show: 'S2', languages: ['zh'] };
  const s2 = evaluateScreening(other, cut, catalog);
  const blocked = s2.references.filter((ref) => ref.caption === 'Z1');
  assert.ok(blocked.every((ref) => ref.status === 'no-permission'));
  assert.ok(blocked[0].blockers[0].detail.includes('S2'));

  // 语言不一致也不放行：许可只给 zh，en 译稿拿到同一个 grant id 仍被拒。
  const enCatalog = stubCatalog({
    captions: [{
      id: 'EN1', lang: 'en', clip: 'INT-X', from: 100, to: 2900,
      text: 'screen text', grant: 'G1',
    }],
    grants: [{ id: 'G1', shows: ['S1'], lang: 'zh' }],
  });
  const enReport = evaluateScreening({ ...screening, languages: ['en'] }, cut, enCatalog);
  assert.equal(enReport.references[0].status, 'no-permission');
});

test('原语言译稿限制公开时，该段不产生交付 cue，备用语不能顶替该语言放行', () => {
  const catalog = stubCatalog({
    captions: [
      {
        id: 'DEN1', lang: 'zh', clip: 'INT-X', from: 100, to: 2900,
        text: '只允许馆内审阅的一段话', publicDenied: ['S1'], grant: 'G1',
      },
      {
        id: 'OK1', lang: 'en', clip: 'INT-X', from: 100, to: 2900,
        text: 'Public English line.', grant: 'G2',
      },
    ],
    grants: [
      { id: 'G1', shows: ['S1'], lang: 'zh' },
      { id: 'G2', shows: ['S1'], lang: 'en' },
    ],
  });
  const report = evaluateScreening(screening, cut, catalog);
  const denied = report.references.filter((ref) => ref.caption === 'DEN1');
  assert.ok(denied.every((ref) => ref.status === 'public-denied'));
  // 英文备用语本身合规可交付，但它是以 en 身份交付，不能标记成 zh。
  const enCue = report.deliverableCues.find((cue) => cue.caption === 'OK1');
  assert.equal(enCue.lang, 'en');
  assert.equal(report.deliverableCues.some((cue) => cue.caption === 'DEN1'), false);
  assert.equal(report.ready, false);
});

test('撤下区间与未到齐在同一报告中给出不同状态', () => {
  const catalog = new Catalog();
  catalog.ingestRecord('captions', {
    record: 'cap-1', availableFrom: 1, kind: 'caption',
    payload: { id: 'W1', lang: 'zh', clip: 'INT-X', from: 100, to: 3500, text: '后被撤', grant: 'G1' },
  }, 1);
  catalog.ingestRecord('captions', {
    record: 'wd-1', availableFrom: 2, kind: 'withdraw',
    payload: { id: 'W1', range: [100, 3500], revision: 2 },
  }, 2);
  catalog.ingestRecord('captions', {
    record: 'g1', availableFrom: 1, kind: 'grant',
    payload: { id: 'G1', shows: ['S1'], lang: 'zh' },
  }, 1);
  const report = evaluateScreening(screening, cut, catalog);
  const withdrawn = report.references.filter((ref) => ref.caption === 'W1');
  // 两个引用接住的字幕都与撤下区间相交：撤下是内容级事实，优先级高于
  // 第二个引用的越界（uncuttable），两处均判 withdrawn。
  assert.ok(withdrawn.length === 2);
  assert.ok(withdrawn.every((ref) => ref.status === 'withdrawn'));
  // 第二个引用同时保留越界事实，便于提醒翻译补件。
  assert.ok(withdrawn[1].blockers.some((item) => item.reason === 'uncuttable'));
  // en 从未到过任何字幕 -> pending。
  const pending = report.references.filter((ref) => ref.lang === 'en');
  assert.ok(pending.length > 0);
  assert.ok(pending.every((ref) => ref.status === 'pending'));
  assert.ok(report.blockerCounts.withdrawn >= 2);
  assert.ok(report.blockerCounts.pending >= 2);
});

test('多处分界按译者 splits 分区，只有授权断开点能用于剪出两边', () => {
  const segments = buildCaptionSegments({
    id: 'X', from: 0, to: 9000, text: '全文',
    splits: [[3000, '前', '中'], [6000, '中', '后']],
  });
  assert.deepEqual(segments.map((segment) => segment.range), [[0, 3000], [3000, 6000], [6000, 9000]]);
  assert.deepEqual(segments.map((segment) => segment.text), ['前', '中', '后']);
});
