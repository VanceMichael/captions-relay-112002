// 展映来源客户端：持续分页轮询排期、剪辑单、字幕目录三处接口。
// 仅依赖 Node 自带运行库；网络瞬断按指数退避重试，不静默丢数据。

export class SourceError extends Error {
  constructor(message, { status, url, cause } = {}) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.url = url;
    if (cause) this.cause = cause;
  }
}

export class SourceClient {
  #baseUrl;
  #pageLimit;
  #maxAttempts;

  constructor(baseUrl, { pageLimit = 3, maxAttempts = 4 } = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#pageLimit = pageLimit;
    this.#maxAttempts = maxAttempts;
  }

  async #request(path) {
    const url = `${this.#baseUrl}${path}`;
    let lastError;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new SourceError(`来源返回 ${response.status}`, { status: response.status, url });
        }
        return await response.json();
      } catch (error) {
        lastError = error instanceof SourceError
          ? error
          : new SourceError(`来源请求失败：${error.message}`, { url, cause: error });
        if (attempt < this.#maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** (attempt - 1)));
        }
      }
    }
    throw lastError;
  }

  // 根路径用于确认来源名与当前回放阶段。
  async overview() {
    return this.#request('/');
  }

  // 切换回放阶段（演练控制接口），返回切换后的阶段号。
  async setStage(stage) {
    const url = `${this.#baseUrl}/control?stage=${encodeURIComponent(stage)}`;
    let lastError;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const response = await fetch(url, { method: 'POST' });
        if (response.status === 400) {
          throw new SourceError('回放阶段无效', { status: 400, url });
        }
        if (!response.ok) throw new SourceError(`阶段切换返回 ${response.status}`, { status: response.status, url });
        const body = await response.json();
        return body.stage;
      } catch (error) {
        lastError = error instanceof SourceError
          ? error
          : new SourceError(`阶段切换失败：${error.message}`, { url, cause: error });
        if (attempt < this.#maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** (attempt - 1)));
        }
      }
    }
    throw lastError;
  }

  // 顺页取齐一个来源在当前阶段可见的全部记录。
  // 每次调用都是一次完整重读：阶段推进后新到记录与撤下记录都以服务端现状为准。
  async fetchAll(sourceName) {
    const records = [];
    let offset = 0;
    let stage;
    do {
      const page = await this.#request(
        `/source/${encodeURIComponent(sourceName)}?offset=${offset}&limit=${this.#pageLimit}`,
      );
      stage = page.stage;
      records.push(...page.records);
      offset = page.next;
    } while (offset !== null);
    return { records, stage };
  }

  // 一次同步三处来源。
  async sync() {
    const [schedule, editing, captions] = await Promise.all([
      this.fetchAll('schedule'),
      this.fetchAll('editing'),
      this.fetchAll('captions'),
    ]);
    return {
      stage: schedule.stage,
      schedule: schedule.records,
      editing: editing.records,
      captions: captions.records,
    };
  }
}
