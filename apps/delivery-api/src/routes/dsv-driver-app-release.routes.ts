import type { FastifyInstance } from 'fastify';

import type { DsvDriverAppReleaseRepository } from '../modules/dsv/dsv-driver-app-release.repository.js';

export type DsvDriverAppReleaseDependencies = {
  repository: DsvDriverAppReleaseRepository;
};

export function registerDsvDriverAppReleaseRoutes(
  app: FastifyInstance,
  dependencies: DsvDriverAppReleaseDependencies,
): void {
  app.get('/api/dsv/driver/app-release/android', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const release = await dependencies.repository.getAndroidRelease();
    if (release === null) {
      return reply.code(404).send({
        data: null,
        error: {
          code: 'APP_RELEASE_NOT_PUBLISHED',
          message: 'CLEVER Driver Android release has not been published',
        },
      });
    }
    return reply.code(200).send({
      data: { ...release, publishedAt: release.publishedAt.toISOString() },
      error: null,
    });
  });
}
