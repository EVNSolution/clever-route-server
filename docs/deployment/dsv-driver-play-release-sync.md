# DSV Driver Play release synchronization

The existing release registry supports both the legacy direct APK publisher and
an opt-in Play verification mode. Use Play verification for a release producer
that updates the registry after publication. Upload, edit commit, review approval,
and a successful build do not establish production availability.

## Producer invocation

Run the existing publisher in the delivery API runtime with its normal database
configuration. Set `DSV_PLAY_VERIFIER_CREDENTIALS` to the secret service-account
JSON file and `DSV_PLAY_VERIFIER_EMAIL` to the expected dedicated verifier email.
The CLI checks the principal and requests a short-lived token with only the
Android Publisher scope. It has no generic user-token/ADC fallback and never
impersonates a user. Keep the file out of Git and logs; do not create new keys or
permissions as part of running this command.

```bash
node dist/scripts/publish-dsv-driver-app-release.js \
  --verify-play-production true \
  --version-code "$RELEASE_VERSION_CODE" \
  --version-name "$RELEASE_VERSION_NAME" \
  --apk-sha256 "$RELEASE_APK_SHA256" \
  --install-url 'https://play.google.com/store/apps/details?id=com.evnsolution.clever.driver'
```

The version pair and APK digest must come from the same released artifact. The
digest is the SHA-256 of actual APK bytes for that version, such as a Play-generated
universal APK. It is not the AAB digest, signing-certificate fingerprint, or a
previous direct-download APK digest. Check the APK package/version before using
its digest. The existing API and released app require `apkSha256` as 64 hex
characters even when installation opens Play; there is no placeholder value.

Do not supply `--minimum-version-code` in Play mode. The registry must already
exist, and its minimum supported version is preserved. Initialization and changes
to the minimum supported version remain separate operator decisions.

## Publication gate

For `com.evnsolution.clever.driver` only, the verifier:

1. Reads production release summaries and requires the candidate artifact to have
   lifecycle `RELEASE_LIFECYCLE_STATE_PUBLISHED`.
2. Opens a fresh edit, reads production, and requires that version in a
   `completed` release without a partial-rollout fraction or country targeting.
   A newer completed release prevents publishing the older candidate.
3. Rechecks the published lifecycle and deletes its temporary edit before writing
   the database. It never uploads, changes a track, or commits an edit.

The lifecycle check alone is insufficient: Google uses `PUBLISHED` for partial
rollouts as well. Completion applies to the configured production audience, not
every country worldwide. Drafts, pending review, approved but unpublished
releases, halted/partial rollouts, malformed responses, API errors and cleanup
failures all stop the database write.

**Identity constraint:** Google permits one open edit per user. Opening a new edit
invalidates that user's previous edit. The verifier identity must not also own
an upload or Console editing flow. Do not run it with an interactive operator's
token. Concurrent Console edits may invalidate verification; fail and retry a
fresh verification, without committing any edit.

## Retries, logs and integration boundary

An identical registry publication is a no-op. Lower version codes or conflicting
metadata for the same code are rejected. Updating a newer version compares the
previous version and update timestamp, so a stale writer cannot overwrite a
concurrent release or minimum-version policy change. A conflict requires a fresh
read and fresh Play verification before retrying.

Successful publication emits `dsv_driver_release_published`, the version metadata,
previous version code and `published`/`unchanged` outcome. Failure emits a bounded
error code and a nonzero exit status, without provider payloads or credentials.

This command is a gated producer entry point. It does not install a scheduler,
webhook, or Play credential, and does not itself submit a Play release. The release
owner must invoke it after actual production publication and retry when review or
managed publishing finishes. Automatic synchronization is not operational until
that producer connection and dedicated credential are installed and verified.

## References

- [Release summaries and lifecycle states](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases)
- [Track rollout states](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks)
- [Edit isolation and invalidation](https://developers.google.com/android-publisher/edits)
- [Generated APK artifacts](https://developers.google.com/android-publisher/api-ref/rest/v3/generatedapks/list)
- [Service-account token exchange](https://developers.google.com/identity/protocols/oauth2/service-account)
