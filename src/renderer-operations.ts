export interface NewChatDraftSession<TProfile extends string = string> {
  text: string;
  projectId: string | null;
  permissionProfile: TProfile | null;
  skillId: string | null;
}

export function createRendererOperationTracker() {
  let frozen = false;
  const active = new Set<Promise<unknown>>();
  const failures: unknown[] = [];

  return {
    get frozen(): boolean { return frozen; },
    track<T>(operation: () => T | Promise<T>): Promise<T> {
      let task: Promise<T>;
      try { task = Promise.resolve(operation()); }
      catch (error) { task = Promise.reject(error); }
      active.add(task);
      void task.then(
        () => { active.delete(task); },
        (error: unknown) => {
          active.delete(task);
          if (frozen) failures.push(error);
        },
      );
      return task;
    },
    reportFailure(error: unknown): void {
      if (frozen) failures.push(error);
    },
    async freezeAndDrain(): Promise<void> {
      failures.length = 0;
      frozen = true;
      while (active.size > 0) await Promise.allSettled([...active]);
      if (failures.length > 0) throw failures[0];
    },
    resume(): void {
      frozen = false;
      failures.length = 0;
    },
  };
}

export function createNewChatDraftSession<TProfile extends string>(
  session: NewChatDraftSession<TProfile>,
): NewChatDraftSession<TProfile> {
  return { ...session };
}

export async function persistDraftSession<TProfile extends string, TChat extends { id: string; projectId: string | null }>(
  session: NewChatDraftSession<TProfile>,
  initialChat: TChat,
  moveChat: (chatId: string, projectId: string | null) => Promise<TChat>,
  saveDraft: (chatId: string, text: string) => Promise<unknown>,
  saveSelection: (chatId: string, session: Readonly<NewChatDraftSession<TProfile>>) => Promise<unknown>,
): Promise<TChat> {
  let chat = initialChat;
  for (;;) {
    const snapshot = { ...session };
    await saveDraft(chat.id, snapshot.text);
    if (chat.projectId !== snapshot.projectId) chat = await moveChat(chat.id, snapshot.projectId);
    await saveSelection(chat.id, snapshot);
    if (session.text === snapshot.text
      && session.projectId === snapshot.projectId
      && session.permissionProfile === snapshot.permissionProfile
      && session.skillId === snapshot.skillId
      && chat.projectId === snapshot.projectId) return chat;
  }
}

export async function createChatForDraftSession<TProfile extends string, TChat extends { id: string; projectId: string | null }>(
  session: NewChatDraftSession<TProfile>,
  createChat: (projectId: string | null) => Promise<TChat>,
  moveChat: (chatId: string, projectId: string | null) => Promise<TChat>,
  saveDraft: (chatId: string, text: string) => Promise<unknown>,
  saveSelection: (chatId: string, session: Readonly<NewChatDraftSession<TProfile>>) => Promise<unknown>,
  onCreated?: (chat: TChat) => void,
): Promise<TChat> {
  const chat = await createChat(session.projectId);
  onCreated?.(chat);
  return persistDraftSession(session, chat, moveChat, saveDraft, saveSelection);
}

export function shouldOpenCreatedDraftChat<T>(
  session: T,
  activeSession: T | null,
  isHome: boolean,
): boolean {
  return isHome && session === activeSession;
}
