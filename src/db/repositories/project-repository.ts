import type { DbClient } from '../database.js';
import type { Clock } from '../../utils/clock.js';
import { slugify } from './helpers.js';

export interface ProjectRecord {
  id: number;
  name: string;
  slug: string;
  labelDefinitions: unknown;
}

export class ProjectRepository {
  constructor(
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  async create(name: string): Promise<ProjectRecord> {
    let slug = slugify(name);

    if (slug) {
      const existing = await this.db.get(
        'SELECT id, name, slug, label_definitions_json FROM projects WHERE slug = ?',
        [slug],
      ) as
        | {
            id: number;
            name: string;
            slug: string;
            label_definitions_json: string;
          }
        | undefined;

      if (existing) {
        return this.toRecord(existing);
      }
    }

    const result = await this.db.run(
      'INSERT INTO projects (name, slug, label_definitions_json, created_at) VALUES (?, ?, ?, ?)',
      [name, slug, '[]', this.clock.now()],
    );
    const id = Number(result.lastInsertId);

    if (!slug) {
      slug = `proj-${id}`;
      await this.db.run('UPDATE projects SET slug = ? WHERE id = ?', [slug, id]);
    }

    return { id, name, slug, labelDefinitions: [] };
  }

  async getBySlug(slug: string): Promise<ProjectRecord | null> {
    const row = await this.db.get(
      'SELECT id, name, slug, label_definitions_json FROM projects WHERE slug = ?',
      [slug],
    ) as
      | {
          id: number;
          name: string;
          slug: string;
          label_definitions_json: string;
        }
      | undefined;

    return row ? this.toRecord(row) : null;
  }

  async getById(id: number): Promise<ProjectRecord | null> {
    const row = await this.db.get(
      'SELECT id, name, slug, label_definitions_json FROM projects WHERE id = ?',
      [id],
    ) as
      | {
          id: number;
          name: string;
          slug: string;
          label_definitions_json: string;
        }
      | undefined;

    return row ? this.toRecord(row) : null;
  }

  async updateLabelDefinitions(projectId: number, labelDefinitions: unknown): Promise<void> {
    await this.db.run('UPDATE projects SET label_definitions_json = ? WHERE id = ?', [
      JSON.stringify(labelDefinitions),
      projectId,
    ]);
  }

  private toRecord(row: {
    id: number;
    name: string;
    slug: string;
    label_definitions_json: string;
  }): ProjectRecord {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      labelDefinitions: JSON.parse(row.label_definitions_json) as unknown,
    };
  }
}
