import type { ChatSummary, Project } from './contracts';

export function sidebarSections(projects: Project[], chats: ChatSummary[]) {
  const byRecent = <T extends { updatedAt: string }>(a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt);
  const activeProjects = projects.filter((project) => !project.archived).sort(byRecent);
  const activeChats = chats.filter((chat) => !chat.archived).sort(byRecent);
  return {
    activeProjects,
    activeChats,
    pinnedProjects: activeProjects.filter((project) => project.pinned),
    pinnedChats: activeChats.filter((chat) => chat.pinned),
    projects: activeProjects.filter((project) => !project.pinned),
    recentChats: activeChats.filter((chat) => !chat.projectId && !chat.pinned),
    projectChats: (id: string) => activeChats.filter((chat) => chat.projectId === id),
  };
}
