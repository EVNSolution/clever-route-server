# DSV map profile

`GET /api/dsv/v1/map/profile` returns the browser map provider profile for the
DSV web. It uses the standard DSV v1 success/error envelope, requires a valid
DSV browser session, and does not require an endpoint-specific DSV data scope.

The endpoint returns only configuration metadata:

- `profileId`
- `regionCode`
- `providerMode`
- `styleUrl`
- `attribution`
- `version`
- `bounds`
- `initialView`

The delivery API does not proxy, fetch, sign, or cache map tiles for this
contract. The DSV web receives the style URL and loads the style according to
the configured provider mode.

## Runtime env

All values are DSV-specific and must be configured together:

- `DSV_MAP_PROFILE_ID`
- `DSV_MAP_REGION_CODE`
- `DSV_MAP_PROVIDER_MODE`
- `DSV_MAP_STYLE_URL`
- `DSV_MAP_ATTRIBUTION`
- `DSV_MAP_VERSION`
- `DSV_MAP_BOUNDS`
- `DSV_MAP_INITIAL_CENTER`
- `DSV_MAP_INITIAL_ZOOM`
- `DSV_MAP_ALLOWED_HOSTS` for `public_allowlisted` mode

`DSV_MAP_PROVIDER_MODE` must be `self_hosted` or `public_allowlisted`.
`self_hosted` mode accepts same-host absolute paths. `public_allowlisted` mode
accepts either an `https` style URL whose host is listed in
`DSV_MAP_ALLOWED_HOSTS`, or a same-host absolute style path such as
`/map/styles/dsv-korea-v1.json` when `DSV_MAP_ALLOWED_HOSTS` is non-empty. For
same-host public-allowlisted styles, `DSV_MAP_ALLOWED_HOSTS` documents the
style's approved external asset origins.

`DSV_MAP_BOUNDS` is `west,south,east,north`. Longitudes must be within
`[-180, 180]`, latitudes within `[-90, 90]`, `west < east`, and `south < north`.
`DSV_MAP_INITIAL_CENTER` is `lng,lat` and must be inside the bounds.
`DSV_MAP_INITIAL_ZOOM` must be between `0` and `24`.

Missing or invalid configuration fails closed with `503 DEPENDENCY_UNAVAILABLE`.
