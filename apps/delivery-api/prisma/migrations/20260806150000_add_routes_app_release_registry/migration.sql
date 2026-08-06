CREATE TABLE "routes_app_release_artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "platform" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "versionCode" INTEGER NOT NULL,
    "versionName" TEXT NOT NULL,
    "minimumSupportedVersionCode" INTEGER NOT NULL,
    "distributionChannel" TEXT NOT NULL,
    "downloadUrl" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routes_app_release_artifacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "routes_app_release_artifacts_version_bounds_check"
        CHECK ("minimumSupportedVersionCode" > 0 AND "versionCode" > 0 AND "minimumSupportedVersionCode" <= "versionCode"),
    CONSTRAINT "routes_app_release_artifacts_sha256_check"
        CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "routes_app_release_artifacts_download_url_check"
        CHECK ("downloadUrl" LIKE 'https://%')
);

CREATE TABLE "routes_app_release_channels" (
    "channel" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "currentArtifactId" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routes_app_release_channels_pkey" PRIMARY KEY ("channel", "platform")
);

CREATE UNIQUE INDEX "routes_app_release_artifacts_platform_packageId_versionCode_key"
    ON "routes_app_release_artifacts"("platform", "packageId", "versionCode");

CREATE INDEX "routes_app_release_artifacts_platform_distributionChannel_versionCode_idx"
    ON "routes_app_release_artifacts"("platform", "distributionChannel", "versionCode");

CREATE INDEX "routes_app_release_channels_currentArtifactId_idx"
    ON "routes_app_release_channels"("currentArtifactId");

ALTER TABLE "routes_app_release_channels"
    ADD CONSTRAINT "routes_app_release_channels_currentArtifactId_fkey"
    FOREIGN KEY ("currentArtifactId") REFERENCES "routes_app_release_artifacts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
