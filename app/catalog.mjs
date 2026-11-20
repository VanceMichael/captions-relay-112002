// 目录状态库：把三处来源的到达记录归并成当前可用状态。
// 设计原则：
//  - 记录键（record）是来源身份，业务身份（show/cut/caption id）单独维护；
//  - 撤下（withdraw）与尚未到齐（目录里根本没有覆盖）是两类不同事实，分开保留；
//  - 值班员领用生成的快照独立冻结，后续来源更新不得改写已领包。

export class Catalog {
  #ingested = new Map(); // record -> { source, stage, kind }
  #screenings = new Map(); // show -> 当前生效排期（同 show 后到覆盖先到）
  #cuts = new Map(); // cut -> 剪辑单当前版本
  #captions = new Map(); // caption id -> 当前条目（含撤下区间与修订号）
  #grants = new Map(); // grant id -> 许可
  #pickups = new Map(); // receipt -> 领用登记（排期来源声明的已领事实）
  #snapshots = new Map(); // receipt -> 冻结快照
  #stage = 0;

  ingestRecord(sourceName, record, stage) {
    const seen = this.#ingested.get(record.record);
    if (seen && seen.kind === record.kind) {
      return { changed: false, duplicate: true };
    }
    const mark = { source: sourceName, stage, kind: record.kind };
    this.#ingested.set(record.record, mark);
    const payload = record.payload;
    let changed = true;

    switch (record.kind) {
      case 'screening': {
        // 排期锁定节目版与输出语言；同一场次（show）换新节目版时覆盖旧排期。
        const previous = this.#screenings.get(payload.show);
        this.#screenings.set(payload.show, {
          show: payload.show,
          site: payload.site,
          cut: payload.cut,
          languages: [...payload.languages],
          time: payload.time,
          record: record.record,
          arrivedStage: stage,
          superseded: previous && previous.cut !== payload.cut ? previous : previous?.superseded ?? null,
        });
        break;
      }
      case 'pickup': {
        // 排期来源登记的领用事实；快照内容由 relay 在对账时冻结。
        if (!this.#pickups.has(payload.receipt)) {
          this.#pickups.set(payload.receipt, {
            receipt: payload.receipt,
            show: payload.show,
            cut: payload.cut,
            time: payload.time,
            record: record.record,
            arrivedStage: stage,
            snapshot: null,
          });
        }
        break;
      }
      case 'cut': {
        // 节目版允许切换片段次序、重复使用同一原片段；新版本整版替换。
        this.#cuts.set(payload.cut, {
          cut: payload.cut,
          clips: payload.clips.map(([clip, from, to, programStart]) => ({
            clip,
            source: [from, to],
            programStart,
          })),
          record: record.record,
          arrivedStage: stage,
        });
        break;
      }
      case 'caption': {
        const previousCaption = this.#captions.get(payload.id);
        const entry = previousCaption
          ? { ...previousCaption }
          : {
              id: payload.id,
              lang: payload.lang,
              clip: payload.clip,
              from: payload.from,
              to: payload.to,
              text: payload.text,
              splits: [],
              cutOnly: null,
              grant: payload.grant ?? null,
              publicDenied: [],
              revision: 1,
              withdrawnRanges: [],
              record: record.record,
              arrivedStage: stage,
            };
        // 新发布可只更新一处源区间：以新条目字段为准（撤下历史继续累积）。
        entry.lang = payload.lang;
        entry.clip = payload.clip;
        entry.from = payload.from;
        entry.to = payload.to;
        entry.text = payload.text;
        entry.splits = [...(payload.splits ?? [])];
        entry.cutOnly = payload.cutOnly ?? null;
        entry.grant = payload.grant ?? entry.grant;
        entry.publicDenied = [...(payload.publicDenied ?? [])];
        entry.revision = payload.revision ?? entry.revision;
        entry.record = record.record;
        entry.latestStage = stage;
        this.#captions.set(payload.id, entry);
        break;
      }
      case 'withdraw': {
        // 明确撤下：记录到对应字幕条目的撤下区间，保留 revision 便于追溯。
        const entry = this.#captions.get(payload.id) ?? {
          id: payload.id,
          lang: null,
          clip: null,
          from: null,
          to: null,
          text: null,
          splits: [],
          cutOnly: null,
          grant: null,
          publicDenied: [],
          revision: payload.revision ?? 1,
          withdrawnRanges: [],
          record: record.record,
          arrivedStage: stage,
        };
        entry.withdrawnRanges = [
          ...entry.withdrawnRanges.filter((range) => range[0] !== payload.range[0] || range[1] !== payload.range[1]),
          [...payload.range],
        ].sort((a, b) => a[0] - b[0]);
        entry.withdrawRevision = payload.revision ?? entry.withdrawRevision;
        entry.latestStage = stage;
        this.#captions.set(payload.id, entry);
        break;
      }
      case 'grant': {
        this.#grants.set(payload.id, {
          id: payload.id,
          shows: [...payload.shows],
          lang: payload.lang,
          record: record.record,
          arrivedStage: stage,
        });
        break;
      }
      default:
        changed = false;
    }
    return { changed, kind: record.kind };
  }

  // 一次同步：整批归并，返回本轮新见到的记录键，供影响面分析。
  ingestBatch(sourceName, records, stage) {
    this.#stage = stage;
    const fresh = [];
    for (const record of records) {
      const result = this.ingestRecord(sourceName, record, stage);
      if (!result.duplicate) fresh.push({ record: record.record, kind: record.kind, payload: record.payload });
    }
    return fresh;
  }

  get stage() {
    return this.#stage;
  }

  getScreening(show) {
    return this.#screenings.get(show) ?? null;
  }

  listScreenings() {
    return [...this.#screenings.values()].map((entry) => structuredClone(entry));
  }

  getCut(cutId) {
    const cut = this.#cuts.get(cutId);
    return cut ? structuredClone(cut) : null;
  }

  listCuts() {
    return [...this.#cuts.values()].map((entry) => structuredClone(entry));
  }

  listCaptions() {
    return [...this.#captions.values()].map((entry) => structuredClone(entry));
  }

  getCaption(id) {
    const entry = this.#captions.get(id);
    return entry ? structuredClone(entry) : null;
  }

  getGrant(id) {
    const grant = this.#grants.get(id);
    return grant ? structuredClone(grant) : null;
  }

  listGrants() {
    return [...this.#grants.values()].map((entry) => structuredClone(entry));
  }

  getPickup(receipt) {
    const pickup = this.#pickups.get(receipt);
    return pickup ? structuredClone(pickup) : null;
  }

  listPickups() {
    return [...this.#pickups.values()].map((entry) => structuredClone(entry));
  }

  freezeSnapshot(receipt, snapshot) {
    this.#snapshots.set(receipt, structuredClone(snapshot));
    const pickup = this.#pickups.get(receipt);
    if (pickup) {
      pickup.snapshot = structuredClone(snapshot);
      this.#pickups.set(receipt, pickup);
    }
  }

  getSnapshot(receipt) {
    const snapshot = this.#snapshots.get(receipt);
    return snapshot ? structuredClone(snapshot) : null;
  }

  listSnapshots() {
    return [...this.#snapshots.entries()].map(([receipt, snapshot]) => ({
      receipt,
      snapshot: structuredClone(snapshot),
    }));
  }
}
