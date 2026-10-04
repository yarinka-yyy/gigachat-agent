import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalStore } from './store';
import { validateProjectFolder } from './project-paths';

async function ensureDirectory(parent: string, name: string): Promise<string> {
  const safeParent = await validateProjectFolder(parent);
  const target = join(safeParent, name);
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return validateProjectFolder(target);
}

export async function createNumberedProjectFolder(documents: string): Promise<string> {
  const documentsRoot = await validateProjectFolder(documents, documents);
  const appRoot = await ensureDirectory(documentsRoot, 'GigaChat Agent');
  const projectsRoot = await ensureDirectory(appRoot, 'Projects');
  for (let number = 1; number < 100000; number += 1) {
    const folder = join(projectsRoot, `GigaChat Project ${number}`);
    try {
      await validateProjectFolder(projectsRoot);
      await mkdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      continue;
    }
    return validateProjectFolder(folder);
  }
  throw new Error('Не удалось подобрать свободное имя папки проекта.');
}

export async function removeEmptyCreatedFolder(folder: string): Promise<void> {
  await rmdir(folder).catch(() => undefined);
}

export async function prepareProjectFolders(store: Pick<LocalStore, 'listProjects' | 'updateProject' | 'migrateProjectInstructions'>, documents: string): Promise<string[]> {
  const failures: string[] = [];
  for (const project of await store.listProjects()) {
    let createdFolder: string | null = null;
    try {
      if (project.workingFolder) await store.migrateProjectInstructions(project.id);
      else {
        createdFolder = await createNumberedProjectFolder(documents);
        const result = await store.updateProject(project.id, { workingFolder: createdFolder });
        if (result.warning) failures.push(`${project.name}: ${result.warning}`);
        createdFolder = null;
      }
    } catch (error) {
      if (createdFolder) await removeEmptyCreatedFolder(createdFolder);
      failures.push(`${project.name}: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`);
    }
  }
  return failures;
}
