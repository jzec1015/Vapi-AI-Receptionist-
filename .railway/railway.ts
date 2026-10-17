import {
  defineRailway,
  github,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

// Project "remarkable-generosity", production environment only.
// Replaces railway.json (deleted in the same commit); Railway stops reading railway.json on 2026-12-01.
// NOTHING here takes effect until someone runs `railway config apply` (Railway does not read
// .railway/ during deploys). Read infra/proposals/railway-iac-migration.md before applying.
export default defineRailway((ctx) => {
  if (!ctx.isEnvironment("production")) {
    throw new Error(
      `.railway/railway.ts only describes the production environment (got "${ctx.environment}").`,
    );
  }

  const data = volume("vapi-ai-receptionist--volume", {
    region: "sfo",
    sizeMB: 5000,
  });

  const receptionist = service("Vapi-AI-Receptionist-", {
    source: github("jzec1015/Vapi-AI-Receptionist-", { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      // Exactly what the Dockerfile COPYs into the image, plus the Dockerfile and Railway config.
      // Tests, fixtures, *.md and scripts never ship, so they must not trigger a deploy.
      watchPatterns: [
        "/server.mjs",
        "/booking.mjs",
        "/trial.mjs",
        "/package.json",
        "/Dockerfile",
        "/templates/emma-assistant.json",
        "/templates/emma-prompt.txt",
        "/templates/fonts/**",
        "/.railway/**",
      ],
    },
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
      // Volume-backed services cannot overlap old and new containers, so every deploy has a
      // short gap. server.mjs handles SIGTERM (server.close); 20 s lets in-flight calls and
      // webhooks finish and writes to /data flush before SIGKILL.
      drainingSeconds: 20,
    },
    replicas: { sfo: 1 },
    volumeMounts: { "/data": data },
    // Names mirror the live variable list (values stay on Railway).
    env: {
      ADMIN_PASSWORD: preserve(),
      ALERT_CALL_FROM_ID: preserve(),
      ALERT_ROUTES: preserve(),
      ALERT_ROUTES_GOLD_STAR_LIVE: preserve(),
      EMAIL_FROM: preserve(),
      NODE_ENV: preserve(),
      OFFICE_EMAIL: preserve(),
      PUBLIC_BASE_URL: preserve(),
      RESEND_API_KEY: preserve(),
      TELNYX_API_KEY: preserve(),
      TELNYX_FROM: preserve(),
      TRIAL_MAX_ACTIVE: preserve(),
      VAPI_API_KEY: preserve(),
      VAPI_WEBHOOK_SECRET: preserve(),
    },
  });

  return project("remarkable-generosity", {
    resources: [receptionist, data],
  });
});
