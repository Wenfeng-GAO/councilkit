export function liveEmptyProcessMessage(input: {
  ready: boolean;
  active: boolean;
  done: boolean;
  error: boolean;
}): string | null {
  if (input.error) return null;
  if (!input.ready) return "读取过程…";
  if (input.active && !input.done) return "等待首条输出";
  return "尚无过程记录";
}

export function liveFollowNotice(input: {
  pinned: boolean;
  newCount: number;
  resultReady: boolean;
}): { text: string; action: string } | null {
  if (input.pinned) return null;
  if (input.newCount > 0 && input.resultReady) {
    return {
      text: `已暂停跟随 · ${input.newCount} 条新活动 · 结果已就绪`,
      action: "查看结果",
    };
  }
  if (input.newCount > 0) {
    return {
      text: `已暂停跟随 · ${input.newCount} 条新活动`,
      action: "回到最新",
    };
  }
  if (input.resultReady) {
    return { text: "结果已就绪", action: "查看结果" };
  }
  return null;
}
