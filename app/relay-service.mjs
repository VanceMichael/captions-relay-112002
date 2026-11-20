// 领用编排：把来源同步、逐场评估、领用冻结与影响面回查串起来。
import { Catalog } from './catalog.mjs';
import { evaluateScreening, findCaptionReferences, findCutImpact } from './domain.mjs';

export class RelayService {
  #client;
  #catalog;

  constructor(client) {
    this.#client = client;
    this.#catalog = new Catalog();
  }

  get catalog() {
    return this.#catalog;
  }

  // 从三处来源完整重读并归并。返回本轮新到记录与各场次的最新评估。
  async sync() {
    const batch = await this.#client.sync();
    const fresh = [
      ...this.#catalog.ingestBatch('schedule', batch.schedule, batch.stage),
      ...this.#catalog.ingestBatch('editing', batch.editing, batch.stage),
      ...this.#catalog.ingestBatch('captions', batch.captions, batch.stage),
    ];
    // 排期里登记的领用，在当前状态下冻结一次；已冻结的旧回执保持原样。
    for (const pickup of this.#catalog.listPickups()) {
      if (!this.#catalog.getSnapshot(pickup.receipt)) {
        const snapshot = this.#buildSnapshot(pickup.show, pickup.cut, pickup.receipt);
        if (snapshot) this.#catalog.freezeSnapshot(pickup.receipt, snapshot);
      }
    }
    return {
      stage: batch.stage,
      fresh,
      screenings: this.listScreeningReports(),
    };
  }

  #buildSnapshot(show, expectedCut, receipt) {
    const screening = this.#catalog.getScreening(show);
    if (!screening) return null;
    const cut = this.#catalog.getCut(expectedCut ?? screening.cut);
    if (!cut) return null;
    const report = evaluateScreening(screening, cut, this.#catalog);
    return {
      receipt,
      show,
      site: screening.site,
      cut: cut.cut,
      languages: screening.languages,
      frozenStage: this.#catalog.stage,
      frozenAt: new Date().toISOString(),
      // 冻结时的剪辑单与字幕状态一并留底，保证事后能回查旧时码。
      cutRecord: cut.record,
      report,
    };
  }

  // 值班员主动领用：冻结当前评估，返回不可变包。重复领取同回执返回原包。
  claim(show, receipt) {
    const existing = this.#catalog.getSnapshot(receipt);
    if (existing) return existing;
    const screening = this.#catalog.getScreening(show);
    if (!screening) throw new Error(`场次 ${show} 的排期尚未到齐，无法领用`);
    const cut = this.#catalog.getCut(screening.cut);
    if (!cut) throw new Error(`节目版 ${screening.cut} 的剪辑单尚未到齐，无法领用`);
    const snapshot = this.#buildSnapshot(show, screening.cut, receipt);
    this.#catalog.freezeSnapshot(receipt, snapshot);
    return this.#catalog.getSnapshot(receipt);
  }

  listScreeningReports() {
    return this.#catalog.listScreenings().map((screening) => {
      const cut = this.#catalog.getCut(screening.cut);
      if (!cut) {
        return {
          show: screening.show,
          site: screening.site,
          cut: screening.cut,
          ready: false,
          missing: `节目版 ${screening.cut} 的剪辑单尚未到齐`,
          references: [],
          deliverableCues: [],
        };
      }
      return evaluateScreening(screening, cut, this.#catalog);
    });
  }

  getScreeningReport(show) {
    const screening = this.#catalog.getScreening(show);
    if (!screening) return null;
    const cut = this.#catalog.getCut(screening.cut);
    if (!cut) return null;
    return evaluateScreening(screening, cut, this.#catalog);
  }

  // 已领包回查：始终返回冻结时的内容，不随后续来源更新而变化。
  getReceipt(receipt) {
    return this.#catalog.getSnapshot(receipt);
  }

  listReceipts() {
    return this.#catalog.listSnapshots();
  }

  // 新字幕/新权限到达后，核验它在各节目版剪辑前后的每个引用。
  auditCaption(captionId) {
    return findCaptionReferences(captionId, this.#catalog, this.#catalog.listScreenings());
  }

  // 节目版变更影响面：受影响场次与需要回查的已领回执。
  auditCut(cutId) {
    return findCutImpact(cutId, this.#catalog);
  }

  // 某片段的字幕变化会波及哪些场次的哪些引用。
  auditClip(clipId) {
    const impact = [];
    for (const screening of this.#catalog.listScreenings()) {
      const cut = this.#catalog.getCut(screening.cut);
      if (!cut) continue;
      cut.clips.forEach((usage, usageIndex) => {
        if (usage.clip === clipId) impact.push({ show: screening.show, cut: cut.cut, usageIndex });
      });
    }
    return impact;
  }
}
