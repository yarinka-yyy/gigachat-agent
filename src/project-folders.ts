import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalStore } from './store';

export async function createNumberedProjectFolder(documents: string): Promise<string> {
  for (let number = 1; number < 100000; number += 1) {
    const folder = join(documents, `GigaChat Project ${number}`);
    try {
      await mkdir(folder);
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
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
        await store.updateProject(project.id, { workingFolder: createdFolder });
      }
    } catch (error) {
      if (createdFolder) await removeEmptyCreatedFolder(createdFolder);
      failures.push(`${project.name}: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`);
    }
  }
  return failures;
}
