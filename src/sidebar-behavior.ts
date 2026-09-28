export function maxSidebarWidth(workspaceWidth: number, composerWidth: number): number {
  const requiredMain = Math.min(workspaceWidth - 242, Math.max(580, composerWidth + 32));
  return Math.max(242, Math.min(440, workspaceWidth - requiredMain));
}

export function createPreviewExitTimer(schedule: (callback: () => void, delay: number) => number, cancel: (id: number) => void) {
  let timer: number | null = null;
  const clear = (): void => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  return {
    clear,
    schedule(close: () => void): void {
      clear();
      timer = schedule(() => { timer = null; close(); }, 300);
    },
  };
}
