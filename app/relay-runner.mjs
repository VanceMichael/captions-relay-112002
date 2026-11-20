// 持续轮询入口：按间隔从来源取资料，逐阶段输出可领场次与阻塞明细。
// 用法：node app/relay-runner.mjs [baseUrl] [maxStage]
import { RelayService } from './relay-service.mjs';
import { SourceClient } from './source-client.mjs';

const baseUrl = process.argv[2] ?? process.env.SOURCE_URL ?? 'http://127.0.0.1:4100';
const maxStage = Number(process.argv[3] ?? process.env.MAX_STAGE ?? 4);
const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 200);

function summarize(report) {
  const blockers = Object.entries(report.blockerCounts ?? {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}×${count}`)
    .join('、');
  return {
    show: report.show,
    site: report.site,
    cut: report.cut,
    ready: report.ready,
    deliverable: report.deliverableCues.length,
    references: report.references.length,
    blockers,
  };
}

async function main() {
  const client = new SourceClient(baseUrl);
  const relay = new RelayService(client);
  const overview = await client.overview();
  console.log(`已连接来源，阶段总数 ${overview.stages}`);

  for (let stage = 1; stage <= maxStage; stage += 1) {
    await client.setStage(stage);
    const result = await relay.sync();
    console.log(`\n===== 回放阶段 ${result.stage}：新到 ${result.fresh.length} 条 =====`);
    for (const report of result.screenings) {
      console.log(JSON.stringify(summarize(report)));
      if (report.references) {
        for (const ref of report.references) {
          if (ref.status !== 'ready') {
            console.log(
              `  阻塞 ${ref.show} 引用#${ref.usageIndex} ${ref.clip} ${ref.lang}: `
              + `${ref.status}（${ref.blockers.map((item) => item.detail).join('；')}）`,
            );
          }
        }
      }
    }
    if (stage < maxStage) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  console.log('\n===== 已领回执 =====');
  for (const { receipt } of relay.listReceipts()) {
    const snapshot = relay.getReceipt(receipt);
    console.log(`${receipt}: ${snapshot.show}/${snapshot.cut} 冻结于阶段 ${snapshot.frozenStage}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
