CREATE TABLE "dsv_driver_app_releases" (
    "platform" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "latestVersionCode" INTEGER NOT NULL,
    "latestVersionName" TEXT NOT NULL,
    "minimumSupportedVersionCode" INTEGER NOT NULL,
    "installUrl" TEXT NOT NULL,
    "apkSha256" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_driver_app_releases_pkey" PRIMARY KEY ("platform"),
    CONSTRAINT "dsv_driver_app_releases_version_bounds_check"
      CHECK ("minimumSupportedVersionCode" > 0 AND "minimumSupportedVersionCode" <= "latestVersionCode")
);
