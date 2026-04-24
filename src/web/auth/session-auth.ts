import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const SESSION_COOKIE = 'kvault_session';

interface SessionRecord {
  createdAt: number;
}

export class SessionAuth {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly adminPassword: string,
    private readonly sessionTtlMs: number,
  ) {}

  async register(server: FastifyInstance): Promise<void> {
    await server.register(cookie);

    server.decorateRequest('isAuthenticated', false);

    server.addHook('preHandler', async (request, reply) => {
      const isApiRoute = request.url.startsWith('/api/');
      const isPublicRoute =
        request.url.startsWith('/api/auth/') ||
        request.url === '/' ||
        request.url.startsWith('/app.js') ||
        request.url.startsWith('/styles.css');

      if (!isApiRoute || isPublicRoute) {
        this.attachSession(request);
        return;
      }

      if (!this.attachSession(request)) {
        return reply.code(401).send({
          message: '登录已过期，请重新输入管理密码。',
        });
      }
    });
  }

  login(request: FastifyRequest, reply: FastifyReply, password: string): void {
    if (password !== this.adminPassword) {
      throw new Error('管理密码不正确。');
    }

    const sessionId = randomUUID();
    this.sessions.set(sessionId, { createdAt: Date.now() });
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(this.sessionTtlMs / 1000),
    });
    request.isAuthenticated = true;
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const sessionId = request.cookies[SESSION_COOKIE];

    if (sessionId) {
      this.sessions.delete(sessionId);
    }

    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    request.isAuthenticated = false;
  }

  getSessionState(request: FastifyRequest): { authenticated: boolean } {
    return {
      authenticated: this.attachSession(request),
    };
  }

  private attachSession(request: FastifyRequest): boolean {
    const sessionId = request.cookies[SESSION_COOKIE];

    if (!sessionId) {
      request.isAuthenticated = false;
      return false;
    }

    const session = this.sessions.get(sessionId);

    if (!session || Date.now() - session.createdAt > this.sessionTtlMs) {
      this.sessions.delete(sessionId);
      request.isAuthenticated = false;
      return false;
    }

    request.isAuthenticated = true;
    return true;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    isAuthenticated: boolean;
  }
}
