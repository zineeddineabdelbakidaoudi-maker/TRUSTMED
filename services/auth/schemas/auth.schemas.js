const { z } = require('zod');

// ── GET /oauth/authorize query params ──
const authorizeSchema = z.object({
  client_id: z.string().min(1, 'client_id is required'),
  redirect_uri: z.string().url('redirect_uri must be a valid URL'),
  scope: z.string().min(1, 'scope is required'),
  state: z.string().min(1, 'state is required for CSRF protection'),
  response_type: z.literal('code', { errorMap: () => ({ message: 'response_type must be "code"' }) }),
});

// ── POST /oauth/token body ──
const tokenSchema = z.object({
  client_id: z.string().min(1, 'client_id is required'),
  client_secret: z.string().min(1, 'client_secret is required'),
  code: z.string().min(1, 'code is required'),
  redirect_uri: z.string().url('redirect_uri must be a valid URL'),
  grant_type: z.literal('authorization_code').optional(),
});

// ── POST /v1/partner/register body ──
const partnerRegisterSchema = z.object({
  name: z.string().min(1).max(255),
  client_id: z.string().min(3).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'client_id must be alphanumeric with - or _'),
  client_secret: z.string().min(8).max(255),
  redirect_uris: z.array(z.string().url()).min(1, 'At least one redirect_uri is required'),
  allowed_scopes: z.array(z.string().min(1)).min(1, 'At least one scope is required'),
  webhook_url: z.string().url().max(500).optional().nullable(),
  webhook_secret: z.string().max(255).optional().nullable(),
});

module.exports = {
  authorizeSchema,
  tokenSchema,
  partnerRegisterSchema,
};
