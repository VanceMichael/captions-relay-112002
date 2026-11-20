// 核心领域逻辑：逐“片段引用 × 语言 × 字幕子区间”核验覆盖。
// 关键约束：
//  1) 字幕跨过剪辑接点时，只能使用译者 splits 授权断开后的子区间；
//     未授权断开的部分记 uncuttable，需请翻译补件，不得整段送放映；
//  2) withdraw 明确撤下与目录中根本没有覆盖（pending）分开判定；
//  3) 放映许可按场馆/场次/最终语言判定：grant 必须含该 show 且语言一致；
//  4) 备用语只能在排期 languages 的场馆认可顺序内切换；某语言译稿自身
//     publicDenied 时该语言该段不可公开，不能用备用语冒充该语言放行；
//  5) 覆盖按引用核验，同一字幕文件在剪辑前后的每个引用分别结论，不按文件计数。

import { containsRange, intersect, overlapLength, splitIntoRanges } from './time.mjs';

// 把一条字幕按译者授权的 splits 切成子区间，并挂上对应文本。
export function buildCaptionSegments(caption) {
  const boundaries = caption.splits.map(([point]) => point);
  const ranges = splitIntoRanges(caption.from, caption.to, boundaries);
  const beforeText = new Map();
  const afterText = new Map();
  for (const [point, before, after] of caption.splits) {
    beforeText.set(point, before);
    afterText.set(point, after);
  }
  return ranges.map(([segFrom, segTo]) => {
    let text = caption.text;
    if (beforeText.has(segTo)) text = beforeText.get(segTo);
    if (afterText.has(segFrom)) text = afterText.get(segFrom);
    return {
      caption: caption.id,
      lang: caption.lang,
      range: [segFrom, segTo],
      text,
    };
  });
}

function isWithdrawn(caption, range) {
  return (caption.withdrawnRanges ?? []).some(
    (withdrawn) => overlapLength(withdrawn, range) > 0,
  );
}

function clipProgramRange(usage) {
  const length = usage.source[1] - usage.source[0];
  return [usage.programStart, usage.programStart + length];
}

// 评估单场放映。返回逐引用报告与可交付的节目时码 cue 清单。
export function evaluateScreening(screening, cut, catalog) {
  const languages = screening.languages;
  const usages = cut.clips.map((usage, index) => ({ ...usage, usageIndex: index }));
  const references = [];
  const usageReports = [];

  for (const usage of usages) {
    const programRange = clipProgramRange(usage);
    const captionsForClip = catalog
      .listCaptions()
      .filter((caption) => caption.clip === usage.clip)
      // cutOnly 字幕只服务它声明的节目版；源时码字幕不进 cutOnly 通道。
      .filter((caption) => !caption.cutOnly || caption.cutOnly.cut === cut.cut);

    const perLanguage = new Map(languages.map((lang) => [lang, []]));

    for (const caption of captionsForClip) {
      if (!languages.includes(caption.lang)) continue;
      const segments = buildCaptionSegments(caption);
      for (const segment of segments) {
        // cutOnly 条目给出的是节目毫秒，先在节目时轴上判定；否则在源时轴判定。
        const hit = caption.cutOnly
          ? intersect(programRange, segment.range)
          : intersect(usage.source, segment.range);
        if (!hit) continue;

        const fullyInside = caption.cutOnly
          ? containsRange(programRange, segment.range)
          : containsRange(usage.source, segment.range);

        const blockers = [];
        // 越界本身是一个事实；即使越界，公开限制/撤下/许可问题仍要同时登记，
        // 最终状态按 BLOCKER_PRIORITY 取最高优先级，避免拿“需补件”掩盖禁映事实。
        if (!fullyInside) {
          blockers.push({
            reason: 'uncuttable',
            detail: caption.cutOnly
              ? '字幕（节目时码）跨过本片段引用边界，译者未授权在接点断开'
              : '字幕跨过剪辑接点，译者未授权在接点断开，需补件',
            overlap: hit,
          });
        }
        let status = blockers.length ? 'uncuttable' : 'ready';
        const denied = (caption.publicDenied ?? []).includes(screening.show);
        if (denied) {
          status = 'public-denied';
          blockers.push({ reason: 'public-denied', detail: '该译稿明确限制本场次公开放映' });
        } else if (isWithdrawn(caption, segment.range)) {
          status = 'withdrawn';
          blockers.push({ reason: 'withdrawn', detail: '该源区间已被来源明确撤下' });
        } else if (!caption.grant) {
          status = 'no-permission';
          blockers.push({ reason: 'no-permission', detail: '字幕未携带任何放映许可' });
        } else {
          const grant = catalog.getGrant(caption.grant);
          const permitted = grant
            && grant.lang === caption.lang
            && grant.shows.includes(screening.show);
          if (!permitted) {
            status = 'no-permission';
            blockers.push({
              reason: 'no-permission',
              detail: grant
                ? `许可 ${grant.id} 不覆盖场次 ${screening.show} 的 ${caption.lang} 放映`
                : `许可 ${caption.grant} 尚未到齐`,
            });
          }
        }
        // 越界与禁映同时成立时，禁映是更高优先级结论。
        if (status === 'ready' && blockers.some((item) => item.reason === 'uncuttable')) {
          status = 'uncuttable';
        }

        const cueProgramFrom = caption.cutOnly
          ? segment.range[0]
          : usage.programStart + (segment.range[0] - usage.source[0]);
        const cueProgramTo = caption.cutOnly
          ? segment.range[1]
          : usage.programStart + (segment.range[1] - usage.source[0]);

        const reference = {
          show: screening.show,
          site: screening.site,
          cut: cut.cut,
          usageIndex: usage.usageIndex,
          clip: usage.clip,
          clipSource: usage.source,
          programStart: usage.programStart,
          lang: caption.lang,
          caption: caption.id,
          revision: caption.revision,
          sourceRange: caption.cutOnly ? null : segment.range,
          programRange: caption.cutOnly ? segment.range : [cueProgramFrom, cueProgramTo],
          text: segment.text,
          splitAuthorized: true,
          status,
          blockers,
          grant: status === 'ready' ? caption.grant : (caption.grant ?? null),
        };
        references.push(reference);
        perLanguage.get(caption.lang).push(reference);
      }
    }

    // 逐语言判定：完全没有任何覆盖即 pending（尚未到齐），区别于 withdraw。
    const languageStatus = {};
    for (const lang of languages) {
      const refs = perLanguage.get(lang);
      if (refs.length === 0) {
        languageStatus[lang] = 'pending';
        references.push({
          show: screening.show,
          site: screening.site,
          cut: cut.cut,
          usageIndex: usage.usageIndex,
          clip: usage.clip,
          clipSource: usage.source,
          programStart: usage.programStart,
          lang,
          caption: null,
          revision: null,
          sourceRange: null,
          programRange: programRange,
          text: null,
          splitAuthorized: null,
          status: 'pending',
          blockers: [{ reason: 'pending', detail: '目录中尚无覆盖该引用的该语言字幕' }],
          grant: null,
        });
      } else {
        languageStatus[lang] = refs.every((ref) => ref.status === 'ready')
          ? 'ready'
          : (refs.some((ref) => ref.status === 'ready') ? 'partial' : 'blocked');
      }
    }

    usageReports.push({
      usageIndex: usage.usageIndex,
      clip: usage.clip,
      clipSource: usage.source,
      programStart: usage.programStart,
      programRange,
      languageStatus,
      references: languages.flatMap((lang) => perLanguage.get(lang)),
    });
  }

  // 生成可交付 cue。每种输出语言是独立字幕轨道：该语言有 ready 引用就全部交付；
  // 某语言在某引用点完全没有可交付内容时，才按场馆认可顺序用备用语补该点，
  // 且备用 cue 保留自身语言标记，不冒充首选语言。
  const deliverableCues = [];
  for (const usageReport of usageReports) {
    const readyByLang = new Map();
    for (const lang of languages) {
      readyByLang.set(
        lang,
        usageReport.references.filter((ref) => ref.lang === lang && ref.status === 'ready'),
      );
    }
    for (const lang of languages) {
      const own = readyByLang.get(lang);
      if (own.length > 0) {
        for (const ref of own) {
          deliverableCues.push({
            show: screening.show,
            cut: cut.cut,
            usageIndex: usageReport.usageIndex,
            clip: ref.clip,
            lang: ref.lang,
            caption: ref.caption,
            grant: ref.grant,
            programFrom: ref.programRange[0],
            programTo: ref.programRange[1],
            sourceRange: ref.sourceRange,
            text: ref.text,
          });
        }
        continue;
      }
      // 首选语言该点不可交付：按认可顺序找第一种有 ready 内容的备用语补位。
      if (languages.indexOf(lang) === 0) {
        const fallback = languages
          .slice(1)
          .map((candidate) => readyByLang.get(candidate))
          .find((refs) => refs.length > 0);
        if (fallback) {
          for (const ref of fallback) {
            deliverableCues.push({
              show: screening.show,
              cut: cut.cut,
              usageIndex: usageReport.usageIndex,
              clip: ref.clip,
              lang: ref.lang,
              fallbackFor: lang,
              caption: ref.caption,
              grant: ref.grant,
              programFrom: ref.programRange[0],
              programTo: ref.programRange[1],
              sourceRange: ref.sourceRange,
              text: ref.text,
            });
          }
        }
      }
    }
  }

  const blockerCounts = {
    'public-denied': 0,
    withdrawn: 0,
    uncuttable: 0,
    'no-permission': 0,
    pending: 0,
  };
  for (const ref of references) {
    if (ref.status === 'pending') blockerCounts.pending += 1;
    else if (ref.status !== 'ready') blockerCounts[ref.status] += 1;
  }

  const ready = references.length > 0 && references.every((ref) => ref.status === 'ready');
  return {
    show: screening.show,
    site: screening.site,
    cut: cut.cut,
    languages,
    generatedFromStage: catalog.stage,
    ready,
    references,
    usages: usageReports,
    deliverableCues: deliverableCues
      .sort((a, b) => a.programFrom - b.programFrom || a.usageIndex - b.usageIndex),
    blockerCounts,
  };
}

// 审计用评估：忽略场次的输出语言清单，保证指定字幕在任何引用点都能被核验。
function evaluateWithoutLanguageFilter(screening, cut, catalog, captionId) {
  const widened = { ...screening, languages: [] };
  const usages = cut.clips.map((usage, index) => ({ ...usage, usageIndex: index }));
  const findings = [];
  for (const usage of usages) {
    const programRange = clipProgramRange(usage);
    const caption = catalog.getCaption(captionId);
    if (!caption || caption.clip !== usage.clip) continue;
    if (caption.cutOnly && caption.cutOnly.cut !== cut.cut) continue;
    for (const segment of buildCaptionSegments(caption)) {
      const hit = caption.cutOnly
        ? intersect(programRange, segment.range)
        : intersect(usage.source, segment.range);
      if (!hit) continue;
      const fullyInside = caption.cutOnly
        ? containsRange(programRange, segment.range)
        : containsRange(usage.source, segment.range);
      const blockers = [];
      if (!fullyInside) {
        blockers.push({
          reason: 'uncuttable',
          detail: '字幕跨过剪辑接点，译者未授权在接点断开，需补件',
          overlap: hit,
        });
      }
      let status = blockers.length ? 'uncuttable' : 'ready';
      if ((caption.publicDenied ?? []).includes(screening.show)) {
        status = 'public-denied';
        blockers.push({ reason: 'public-denied', detail: '该译稿明确限制本场次公开放映' });
      } else if (isWithdrawn(caption, segment.range)) {
        status = 'withdrawn';
        blockers.push({ reason: 'withdrawn', detail: '该源区间已被来源明确撤下' });
      } else if (!caption.grant) {
        status = 'no-permission';
        blockers.push({ reason: 'no-permission', detail: '字幕未携带任何放映许可' });
      } else {
        const grant = catalog.getGrant(caption.grant);
        const permitted = grant
          && grant.lang === caption.lang
          && grant.shows.includes(screening.show);
        if (!permitted) {
          status = 'no-permission';
          blockers.push({ reason: 'no-permission', detail: `许可 ${caption.grant} 不覆盖该场次/语言` });
        }
      }
      if (status === 'ready' && blockers.some((item) => item.reason === 'uncuttable')) {
        status = 'uncuttable';
      }
      const programFrom = caption.cutOnly
        ? segment.range[0]
        : usage.programStart + (segment.range[0] - usage.source[0]);
      const programTo = caption.cutOnly
        ? segment.range[1]
        : usage.programStart + (segment.range[1] - usage.source[0]);
      findings.push({
        show: screening.show,
        cut: cut.cut,
        usageIndex: usage.usageIndex,
        clip: usage.clip,
        lang: caption.lang,
        sourceRange: caption.cutOnly ? null : segment.range,
        programRange: caption.cutOnly ? segment.range : [programFrom, programTo],
        status,
        blockers,
      });
    }
  }
  return findings;
}

// 影响面核验：给定一个字幕（如新补到、带新权限的文件），找出它在所有节目版
// 剪辑前后的每个引用并逐条给出当前结论。不能用“文件数”代替覆盖。
// 审计范围同时包含：仍在排映的 cut，以及目录中已不再排映的历史 cut（已领包回查用）；
// 且不按场次输出语言过滤——一份 zh 译稿在只排 en 的场次里同样要给出许可结论。
export function findCaptionReferences(captionId, catalog, screenings) {
  const caption = catalog.getCaption(captionId);
  if (!caption) return [];
  const findings = [];

  const scheduledCuts = new Set(screenings.map((screening) => screening.cut));
  for (const screening of screenings) {
    const cutsToInspect = [
      catalog.getCut(screening.cut),
      ...catalog.listCuts().filter((cut) => !scheduledCuts.has(cut.cut)),
    ].filter(Boolean);
    for (const cut of cutsToInspect) {
      findings.push(...evaluateWithoutLanguageFilter(screening, cut, catalog, captionId));
    }
  }
  return findings;
}

// 哪些场次受某节目版变更影响：返回仍在用该 cut 的场次与已领用但节目版已换的回执。
export function findCutImpact(cutId, catalog) {
  const affectedShows = catalog.listScreenings()
    .filter((screening) => screening.cut === cutId)
    .map((screening) => screening.show);
  const staleReceipts = catalog.listPickups()
    .filter((pickup) => pickup.cut === cutId)
    .map((pickup) => pickup.receipt);
  return { cut: cutId, affectedShows, staleReceipts };
}
