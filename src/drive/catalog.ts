import { SpreadsheetRecord } from '../domain/types.js';

export const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const GOOGLE_SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  modifiedTime?: string;
  version?: string;
  driveId?: string;
}

function resolvePath(
  file: DriveFileMetadata,
  filesById: ReadonlyMap<string, DriveFileMetadata>,
  selectedFolders: ReadonlySet<string>
): string[] | null {
  const visit = (current: DriveFileMetadata, seen: ReadonlySet<string>): string[] | null => {
    if (seen.has(current.id)) {
      return null;
    }
    if (selectedFolders.has(current.id)) {
      return [current.name];
    }
    const nextSeen = new Set(seen).add(current.id);
    const candidates = current.parents.flatMap((parentId) => {
      const parent = filesById.get(parentId);
      const path = parent ? visit(parent, nextSeen) : null;
      return path ? [[...path, current.name]] : [];
    });
    candidates.sort((first, second) =>
      first.length === second.length
        ? first.join('/').localeCompare(second.join('/'))
        : first.length - second.length
    );
    return candidates[0] ?? null;
  };
  return visit(file, new Set());
}

export function buildSelectedCatalog(
  files: readonly DriveFileMetadata[],
  selectedFolderIds: readonly string[]
): SpreadsheetRecord[] {
  const filesById = new Map(files.map((file) => [file.id, file]));
  const selectedFolders = new Set(selectedFolderIds);
  return files
    .filter((file) => file.mimeType === GOOGLE_SHEET_MIME_TYPE)
    .flatMap((file) => {
      const path = resolvePath(file, filesById, selectedFolders);
      if (!path) {
        return [];
      }
      return [
        {
          id: file.id,
          name: file.name,
          path: `/${path.join('/')}`,
          modifiedTime: file.modifiedTime ?? '',
          version: file.version ?? '',
          indexStatus: 'pending' as const,
          lastIndexedAt: null,
        },
      ];
    })
    .sort((first, second) => first.path.localeCompare(second.path));
}
