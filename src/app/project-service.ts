import type { ProjectRepository } from '../db/repositories/index.js';

export class ProjectService {
  constructor(private readonly projects: ProjectRepository) {}

  async createProject(name: string): Promise<{ id: number; slug: string }> {
    const project = await this.projects.create(name);
    return {
      id: project.id,
      slug: project.slug,
    };
  }

  async getLabelDefinitions(projectId: number): Promise<unknown> {
    const project = await this.getProject(projectId);
    return project.labelDefinitions;
  }

  async updateLabelDefinitions(projectId: number, labelDefinitions: unknown): Promise<void> {
    await this.getProject(projectId);
    await this.projects.updateLabelDefinitions(projectId, labelDefinitions);
  }

  private async getProject(projectId: number) {
    const project = await this.projects.getById(projectId);

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    return project;
  }
}
