import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../../utils/clock.js';
import { type RowIdResult, slugify, toId } from './helpers.js';

export interface ProjectRecord {
  id: number;
  name: string;
  slug: string;
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
        .prepare('SELECT id, name, slug FROM projects WHERE slug = ?')
        .get(slug) as ProjectRecord | undefined;

      if (existing) {
        return existing;
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

    return { id, name, slug };
  }

  getBySlug(slug: string): ProjectRecord | null {
    return (
      (this.db
        .prepare('SELECT id, name, slug FROM projects WHERE slug = ?')
        .get(slug) as ProjectRecord | undefined) ?? null
    );
  }

  getById(id: number): ProjectRecord | null {
    return (
      (this.db
        .prepare('SELECT id, name, slug FROM projects WHERE id = ?')
        .get(id) as ProjectRecord | undefined) ?? null
    );
  }
}

