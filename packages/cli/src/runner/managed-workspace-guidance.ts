/**
 * @responsibility Renders stable operator guidance for workspace lifecycle refusals.
 */
/** Stable operator guidance for US-LOOP-124 lifecycle refusals. */
import { resolveLang, t, type Catalog } from "@roll/spec";

const catalog: Catalog = {
  "worktree.reservation_refused": {
    en: "[US-LOOP-124] reservation refused for %s: owned by %s; recovery required before a new worktree can be allocated",
    zh: "[US-LOOP-124] 已拒绝为 %s 保留：当前由 %s 持有；须先恢复，才能分配新的 worktree",
  },
  "worktree.allocation_recovery": {
    en: "US-LOOP-124: allocation recovery_required for %s; %s",
    zh: "US-LOOP-124：%s 的分配需要恢复；%s",
  },
  "worktree.allocation_reason.reservation_required": {
    en: "a Story reservation is required before allocation",
    zh: "分配前必须持有 Story reservation",
  },
  "worktree.allocation_reason.reservation_mismatch": {
    en: "the durable reservation does not belong to this run",
    zh: "持久化 reservation 不属于当前运行",
  },
  "worktree.allocation_reason.base_invalid": {
    en: "the integration base is not a commit",
    zh: "集成基线不是 commit",
  },
  "worktree.allocation_reason.submodule_base_invalid": {
    en: "the submodule integration base is not a commit",
    zh: "submodule 集成基线不是 commit",
  },
  "worktree.allocation_reason.identity_invalid": {
    en: "the canonical workspace identity is invalid",
    zh: "规范工作区身份无效",
  },
  "worktree.allocation_reason.operation_write_failed": {
    en: "the pre-effect allocation operation could not be recorded",
    zh: "无法记录 Git effect 之前的分配操作",
  },
  "worktree.allocation_reason.git_add_failed": {
    en: "git worktree add failed",
    zh: "git worktree add 失败",
  },
  "worktree.allocation_reason.reservation_failed": {
    en: "the Story reservation could not be claimed",
    zh: "无法获取 Story reservation",
  },
  "worktree.release_recovery": {
    en: "US-LOOP-124: release recovery_required for %s; %s — preserved",
    zh: "US-LOOP-124：%s 的释放需要恢复；%s — 已保留",
  },
  "worktree.release_reason.missing_identity": {
    en: "managed workspace identity is missing",
    zh: "受管工作区身份缺失",
  },
  "worktree.release_reason.preconditions": {
    en: "fresh member inspection, merged delivery, and accepted attest are required before release",
    zh: "释放前必须完成成员实时检查、确认已合并交付并获得已接受的验收证明",
  },
  "worktree.release_reason.inspection_unknown": {
    en: "Git inspection is unavailable and absence is unproven",
    zh: "Git 检查不可用且无法证明工作区不存在",
  },
  "worktree.release_reason.expected_head_incomplete": {
    en: "durable expected HEAD is incomplete",
    zh: "持久化的预期 HEAD 不完整",
  },
  "worktree.release_reason.event_missing": {
    en: "Git deletion completed but the released event is missing",
    zh: "Git 删除已完成但缺少 released 事件",
  },
  "worktree.release_reason.effect_refused": {
    en: "compare-and-revalidate release was refused",
    zh: "比较并重新验证的释放操作被拒绝",
  },
  "worktree.release_reason.verdict": {
    en: "US-LOOP-123 release verdict: %s",
    zh: "US-LOOP-123 释放裁决：%s",
  },
};

function lang(): "en" | "zh" {
  return resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
}

export function reservationRefused(storyId: string, owner: string): string {
  return t(catalog, lang(), "worktree.reservation_refused", storyId, owner);
}

export function allocationRecovery(storyId: string, reason: string): string {
  return t(catalog, lang(), "worktree.allocation_recovery", storyId, reason);
}

export function allocationReason(key: "reservation_required" | "reservation_mismatch" | "base_invalid" | "submodule_base_invalid" | "identity_invalid" | "operation_write_failed" | "git_add_failed" | "reservation_failed"): string {
  return t(catalog, lang(), `worktree.allocation_reason.${key}`);
}

export function releaseRecovery(runId: string, reason: string): string {
  return t(catalog, lang(), "worktree.release_recovery", runId, reason);
}

export function releaseReason(key: "missing_identity" | "preconditions" | "inspection_unknown" | "expected_head_incomplete" | "event_missing" | "effect_refused"): string {
  return t(catalog, lang(), `worktree.release_reason.${key}`);
}

export function releaseVerdict(verdict: string): string {
  return t(catalog, lang(), "worktree.release_reason.verdict", verdict);
}
