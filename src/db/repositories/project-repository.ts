import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../../utils/clock.js';
import { type RowIdResult, slugify, toId } from './helpers.js';

export interface ProjectRecord {
  id: number;
  name: string;
  slug: string;
  tagDefinitions: unknown;
}

export class ProjectRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  create(name: string): ProjectRecord {
    let slug = slugify(name);

    if (slug) {
      const existing = this.db
        .prepare('SELECT id, name, slug, tag_definitions_json FROM projects WHERE slug = ?')
        .get(slug) as
        | {
            id: number;
            name: string;
            slug: string;
            tag_definitions_json: string;
          }
        | undefined;

      if (existing) {
        return this.toRecord(existing);
      }
    }

    const result = this.db
      .prepare(
        'INSERT INTO projects (name, slug, tag_definitions_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(name, slug, '[]', this.clock.now()) as RowIdResult;

    const id = toId(result);

    if (!slug) {
      slug = `proj-${id}`;
      this.db.prepare('UPDATE projects SET slug = ? WHERE id = ?').run(slug, id);
    }

    return { id, name, slug, tagDefinitions: [] };
  }

  getBySlug(slug: string): ProjectRecord | null {
    const row = this.db
      .prepare('SELECT id, name, slug, tag_definitions_json FROM projects WHERE slug = ?')
      .get(slug) as
      | {
          id: number;
          name: string;
          slug: string;
          tag_definitions_json: string;
        }
      | undefined;

    return row ? this.toRecord(row) : null;
  }

  getById(id: number): ProjectRecord | null {
    const row = this.db
      .prepare('SELECT id, name, slug, tag_definitions_json FROM projects WHERE id = ?')
      .get(id) as
      | {
          id: number;
          name: string;
          slug: string;
          tag_definitions_json: string;
        }
      | undefined;

    return row ? this.toRecord(row) : null;
  }

  updateTagDefinitions(projectId: number, tagDefinitions: unknown): void {
    this.db
      .prepare('UPDATE projects SET tag_definitions_json = ? WHERE id = ?')
      .run(JSON.stringify(tagDefinitions), projectId);
  }

  private toRecord(row: {
    id: number;
    name: string;
    slug: string;
    tag_definitions_json: string;
  }): ProjectRecord {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      tagDefinitions: JSON.parse(row.tag_definitions_json) as unknown,
    };
  }
}
