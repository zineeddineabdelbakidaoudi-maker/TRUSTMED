# TrustMed Frontend — Complete Build Plan (A to Z)

> **Target Agent**: Claude Code  
> **Project Root**: `C:\Users\zinouuuuu\Documents\TRUSTMEDZ`  
> **Frontend Root**: `C:\Users\zinouuuuu\Documents\TRUSTMEDZ\frontend` (does NOT exist yet — you must create it)  
> **Backend**: Already running at `http://localhost:8000` (Node.js/Express)  
> **Database**: PostgreSQL on `localhost:5432`, database `trustmed`, user `trustmed`  
> **Deployment Target**: Vercel (frontend only)  
> **Language**: English UI only. No French. No Arabic.

---

## 0. CRITICAL RULES — READ BEFORE WRITING ANY CODE

1. **DO NOT USE TAILWIND CSS** unless you install `@tailwindcss/postcss` (NOT the base `tailwindcss` package) and configure `postcss.config.js` with `"@tailwindcss/postcss": {}`. Next.js 16+ requires this. If you use Tailwind classes without this, the build will fail.
2. **Every page that uses hooks, state, animations, or browser APIs MUST start with `'use client';`** at the top. Next.js App Router defaults to Server Components.
3. **DO NOT use `<style jsx>`** in any file. It causes build errors in Next.js 16 Server Components.
4. **DO NOT use `className="text-[var(--primary)]"`** — Tailwind cannot process CSS variables this way. Use inline styles or define proper Tailwind theme extensions instead.
5. **All buttons must be functional.** No `onClick={() => {}}` empty handlers. No simulated delays with `setTimeout`. Every user action must hit a real API endpoint or display a real error.
6. **The backend is already built and running.** Do not create mock APIs, fake data, or placeholder responses. Wire everything to the real Express endpoints documented below.
7. **Use vanilla CSS (CSS Modules) OR Tailwind v4 with @tailwindcss/postcss.** Pick one and be consistent. Do not mix.
8. **Kill any running process on port 3000 before starting `npm run dev`.**
9. **Do not modify any backend files** (`server.js`, anything in `/services/`, `/shared/`, `/migrations/`). The backend is production-ready.

---

## 1. PROJECT INITIALIZATION

```bash
cd C:\Users\zinouuuuu\Documents\TRUSTMEDZ
npx -y create-next-app@latest frontend --js --app --no-tailwind --no-eslint --no-src-dir --import-alias "@/*"
cd frontend
npm install framer-motion lucide-react axios
```

Create `.env.local` in `frontend/`:
```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

---

## 2. EXISTING BACKEND API — COMPLETE ENDPOINT REFERENCE

The Express backend runs on port 8000. Here is every endpoint the frontend must consume:

### 2.1 OAuth Flow (Partner Integration)
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/oauth/authorize?client_id=&redirect_uri=&scope=&state=&response_type=code` | None | Initiates OAuth2 flow, redirects to `/verify?session_id=` |
| `POST` | `/oauth/token` | None | Exchanges auth code for JWT. Body: `{client_id, client_secret, code, redirect_uri}` |

### 2.2 Practitioner Routes (Require Bearer JWT)
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/v1/practitioner/me` | Bearer JWT | Returns practitioner profile (fields filtered by scopes) |
| `POST` | `/v1/practitioner/consent` | Bearer JWT | Records privacy consent. Body: `{privacy_policy: true, terms: true}` |
| `POST` | `/v1/practitioner/documents` | Bearer JWT | Upload document. Multipart: `file` (binary) + `doc_type` (CIN/DIPLOMA/CNOM_CARD/AGREMENT/SELFIE) |
| `GET` | `/v1/practitioner/documents` | Bearer JWT | List practitioner's documents |
| `POST` | `/v1/practitioner/phone/request` | Bearer JWT | Request OTP. Body: `{phone_number: "+213XXXXXXXXX"}` |
| `POST` | `/v1/practitioner/phone/verify` | Bearer JWT | Verify OTP. Body: `{otp: "123456"}` |

### 2.3 Badge / Public Verification
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/v1/badge/:practitioner_id.svg` | None | Returns SVG badge image |
| `GET` | `/v1/badge/:practitioner_id/json` | None | Returns badge JSON: `{trust_score, badge_level, badge_label, risk_level, ...}` |
| `GET` | `/v1/verify/:practitioner_id` | None | Public HTML verification page |

### 2.4 Admin Dashboard (Require Admin JWT via `Authorization: Bearer <token>`)
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `POST` | `/admin/login` | None | Admin login. Body: `{email, password}`. Returns `{access_token, role, full_name}` |
| `GET` | `/admin/queue?status=PENDING&page=1&limit=20` | Admin JWT | Paginated review queue with practitioner + document data |
| `GET` | `/admin/queue/stats` | Admin JWT | Queue statistics: `{pending, assigned, resolved_today, avg_resolution_hours}` |
| `POST` | `/admin/queue/:queue_id/assign` | Admin JWT | Self-assign a case |
| `GET` | `/admin/cases/:practitioner_id` | Admin JWT | Full case detail (practitioner, documents, CNOM results, phone, legal, audit trail) |
| `GET` | `/admin/cases/:practitioner_id/documents/:document_id/download` | Admin JWT | Download decrypted document |
| `POST` | `/admin/cases/:queue_id/approve` | Admin JWT | Approve case. Body: `{notes}` |
| `POST` | `/admin/cases/:queue_id/reject` | Admin JWT | Reject case. Body: `{notes}` (required) |
| `POST` | `/admin/cases/:queue_id/request-more-info` | Admin JWT | Request more info. Body: `{message}` (required) |
| `POST` | `/admin/cases/practitioners/:practitioner_id/freeze` | Admin (ADMIN role) | Freeze practitioner. Body: `{reason}` |
| `POST` | `/admin/cases/practitioners/:practitioner_id/unfreeze` | Admin (ADMIN role) | Unfreeze. Body: `{reason}` |
| `GET` | `/admin/cases/practitioners/:id/vouches` | Admin (ADMIN role) | View vouch network |
| `GET` | `/admin/cases/practitioners/:id/shadow-ban` | Admin (ADMIN role) | Shadow ban status |

### 2.5 Health Check
| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/health` | None | Returns `{status: "ok", service: "trustmed", timestamp}` |

---

## 3. DATABASE SCHEMA — KEY TABLES

### practitioners
```sql
id (UUID PK), trustmed_id (VARCHAR unique, format TM-XX-XXXX-XXXX), 
nfc_identity_hash, full_name, cin_number (unique), specialty, wilaya_code,
cnom_number (unique), verification_status (ENUM: IDENTITY_PENDING | IDENTITY_CONFIRMED | PROVISIONAL | CNOM_CONFIRMED | FULLY_VERIFIED | FLAGGED | SUSPENDED),
trust_score (0-100), badge_level (NONE | IDENTITY_VERIFIED | CNOM_CONFIRMED | CNOM_CONFIRMED_PLUS | FULLY_VERIFIED),
risk_score, risk_flags, base_trust_score, trust_confidence,
created_at, updated_at
```

### documents
```sql
id (UUID PK), practitioner_id (FK), doc_type (CIN | DIPLOMA | CNOM_CARD | AGREMENT | SELFIE),
storage_key, size_bytes, checksum_sha256, status (UPLOADED | PROCESSING | VERIFIED | REJECTED | SUPERSEDED),
ocr_result (JSONB), fraud_score (0-100), fraud_flags (JSONB),
created_at
```

### verification_sessions
```sql
id (UUID PK), partner_id (FK), practitioner_id (FK), auth_code, auth_code_exp,
state, redirect_uri, scopes (TEXT[]), status, access_token, token_exp, used_at
```

### reviewer_queue
```sql
id (UUID PK), practitioner_id (FK), document_id (FK), reason, status (PENDING | ASSIGNED | RESOLVED),
assigned_to, resolution, resolution_notes, resolved_at, created_at
```

### admin_users
```sql
id (UUID PK), email (unique), password_hash, role (REVIEWER | ADMIN), full_name, is_active, last_login_at
```

---

## 4. VERIFICATION STATUS FLOW

```
IDENTITY_PENDING → (NFC + liveness) → IDENTITY_CONFIRMED → (legal declaration + docs uploaded) → PROVISIONAL → (CNOM scraper match) → CNOM_CONFIRMED → (phone OTP verified) → FULLY_VERIFIED

At any point: → FLAGGED (anomaly) or → SUSPENDED (admin action)
```

### Trust Score Breakdown
| Signal | Points |
|--------|--------|
| NFC Identity Anchor | +30 |
| Legal Declaration Signed | +15 |
| CNOM Scraper Confirmed | +35 |
| Phone OTP Verified | +14 |
| Clean Document Check | +6 |
| **Maximum** | **100** |

### Badge Levels
| Score | Badge |
|-------|-------|
| 0–29 | None |
| 30–44 | Identity Verified |
| 45–79 | CNOM Confirmed |
| 80–93 | CNOM Confirmed + |
| 94–100 | Fully Verified ✅ |

---

## 5. PAGES TO BUILD

### 5.1 Landing Page (`/`)
- Hero section with animated gradient background
- Headline: "The trusted medical verification layer for Algeria"
- Subtext explaining the OAuth-style flow
- CTA button → links to `/verify`
- Feature cards: 256-bit encryption, CNOM verified, Legal compliance, Vision AI fraud detection
- Smooth staggered entrance animations (framer-motion)
- Footer with links

### 5.2 Verification Portal (`/verify`)
This is the core product. A multi-step wizard that walks a doctor through the full verification flow. Every step hits a real backend endpoint.

**Step 1 — Identity (NFC Scan)**
- Visual: camera/fingerprint icon with animated dashed border
- Button: "Scan NFC Document" → In browser context, this simulates NFC by sending a test payload to the backend. The backend creates the practitioner record and returns a JWT.
- On success: store the JWT in state/localStorage, advance to step 2
- Error handling: show red error banner if backend is unreachable

**Step 2 — Legal Declaration**
- Display full legal text in a scrollable container
- Reference Art. 243 Code Pénal (styled as a red warning box)
- Checkbox: "I accept full criminal and civil liability..."
- Button: "Sign & Continue" → `POST /v1/practitioner/consent` with Bearer JWT
- Checkbox must be checked to enable button

**Step 3 — Document Upload**
- Two upload zones: "Medical Diploma" and "CNOM Card"
- Real `<input type="file">` with hidden input, triggered by clicking the zone
- When file selected: show filename, green checkmark
- Button: "Submit & Analyze" → `POST /v1/practitioner/documents` with `multipart/form-data`, field `file` + `doc_type`
- Upload each document separately (two API calls)
- Show real loading spinner during upload
- On success: advance to step 4

**Step 4 — Status Dashboard**
- Animated circular trust score gauge (SVG circle with animated stroke-dashoffset)
- Score value fetched from `GET /v1/badge/:practitioner_id/json`
- Poll every 3 seconds to show live updates as backend processes documents
- Timeline of completed steps with green checkmarks
- If `badge_level === 'NONE'` or trust_score is low: show amber warning "Manual review required"
- Display practitioner ID (first 8 chars of UUID)

**Progress bar** at top showing step 1-4 progress, animated width transition.

### 5.3 Admin Login (`/admin/login`)
- Email + password form
- `POST /admin/login` → stores `access_token` in state/localStorage
- On success → redirect to `/admin`
- Error states: invalid credentials, server error

### 5.4 Admin Dashboard (`/admin`)
- **Requires authentication** — redirect to `/admin/login` if no token
- **Sidebar** navigation: Queue, Fraud Alerts, Practitioners
- **Top bar** with search input and admin user info
- **Stats cards** (4 across): Total verifications, Pending queue count, Fraud flags, Approval rate — fetched from `GET /admin/queue/stats`
- **Data table**: paginated list from `GET /admin/queue?status=PENDING`
  - Columns: Practitioner name/ID, Specialty, Trust Score (with progress bar), Status badge, Actions
  - Each row clickable → expands or navigates to case detail

### 5.5 Case Review Page (`/admin/case/[id]`)
- Full practitioner profile fetched from `GET /admin/cases/:practitioner_id`
- Sections:
  - Identity info (name, CIN, specialty, wilaya)
  - Documents list with download buttons → `GET /admin/cases/:id/documents/:doc_id/download`
  - CNOM verification results
  - Phone verification status
  - Legal declaration details
  - Audit trail timeline
- Action buttons:
  - ✅ Approve → `POST /admin/cases/:queue_id/approve`
  - ❌ Reject → `POST /admin/cases/:queue_id/reject` (requires notes textarea)
  - 📋 Request More Info → `POST /admin/cases/:queue_id/request-more-info`
  - 🔒 Freeze → `POST /admin/cases/practitioners/:id/freeze`

---

## 6. DESIGN SYSTEM — AESTHETIC REQUIREMENTS

### Color Palette
```css
--background: #0a0f1e;        /* Deep space navy */
--surface: #111827;           /* Card background */
--surface-hover: #1e293b;     /* Card hover */
--border: #1e293b;            /* Subtle borders */
--primary: #10b981;           /* Medical emerald green */
--primary-hover: #059669;     /* Darker emerald */
--danger: #ef4444;            /* Red for fraud alerts */
--warning: #f59e0b;           /* Amber for pending states */
--info: #3b82f6;              /* Blue for identity */
--text-primary: #f8fafc;      /* White text */
--text-secondary: #94a3b8;    /* Muted gray text */
--text-muted: #64748b;        /* Very muted */
```

### Typography
- Use system font stack: `system-ui, -apple-system, 'Segoe UI', sans-serif`
- Or import Inter from Google Fonts
- Headings: bold/extrabold, tight letter-spacing
- Body: regular weight, relaxed line-height

### Visual Style
- **Glassmorphism cards**: semi-transparent backgrounds with `backdrop-filter: blur(12px)`, subtle 1px borders
- **Ambient glow**: large, blurred, semi-transparent circles in the background using the primary color
- **Micro-animations**: hover lifts on cards (translateY -4px), scale on button press, smooth color transitions
- **Loading states**: pulsing spinners with border-top animation, skeleton loaders for tables
- **Dark mode only** — no light mode toggle

### Animation Requirements (Framer Motion)
- Page entrance: staggered fade-in from bottom (children appear 0.1s apart)
- Step transitions: slide left/right with AnimatePresence
- Trust score circle: animated stroke-dashoffset over 1.5 seconds
- Cards: whileHover={{ y: -4 }}, whileTap={{ scale: 0.98 }}
- Progress bar: animated width with spring transition
- Error banners: slide down from top with opacity fade
- Table rows: staggered fade-in (0.05s per row)

---

## 7. FILE STRUCTURE

```
frontend/
├── app/
│   ├── globals.css              ← Design tokens, resets, global styles
│   ├── layout.js                ← Root layout (metadata, font, body class)
│   ├── page.js                  ← Landing page ('use client')
│   ├── verify/
│   │   └── page.js              ← Verification wizard ('use client')
│   ├── admin/
│   │   ├── login/
│   │   │   └── page.js          ← Admin login form ('use client')
│   │   ├── page.js              ← Admin dashboard ('use client')
│   │   └── case/
│   │       └── [id]/
│   │           └── page.js      ← Case review page ('use client')
├── lib/
│   └── api.js                   ← Axios instance + all API functions
├── components/                  ← Reusable components (optional)
├── .env.local
├── next.config.js
└── package.json
```

---

## 8. API CLIENT (`lib/api.js`)

```javascript
import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
  timeout: 30000,
});

// Attach JWT token to all requests if available
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('trustmed_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// --- Practitioner APIs ---
export const registerPractitioner = (nfcData) => api.post('/v1/practitioner/register', nfcData);
export const getProfile = () => api.get('/v1/practitioner/me');
export const recordConsent = () => api.post('/v1/practitioner/consent', { privacy_policy: true, terms: true });
export const uploadDocument = (file, docType) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('doc_type', docType);
  return api.post('/v1/practitioner/documents', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};
export const requestOtp = (phoneNumber) => api.post('/v1/practitioner/phone/request', { phone_number: phoneNumber });
export const verifyOtp = (otp) => api.post('/v1/practitioner/phone/verify', { otp });
export const getBadgeJson = (practitionerId) => api.get(`/v1/badge/${practitionerId}/json`);

// --- Admin APIs ---
export const adminLogin = (email, password) => api.post('/admin/login', { email, password });
export const getQueueStats = () => api.get('/admin/queue/stats');
export const getQueue = (status = 'PENDING', page = 1) => api.get(`/admin/queue?status=${status}&page=${page}&limit=20`);
export const getCase = (practitionerId) => api.get(`/admin/cases/${practitionerId}`);
export const assignCase = (queueId) => api.post(`/admin/queue/${queueId}/assign`);
export const approveCase = (queueId, notes) => api.post(`/admin/cases/${queueId}/approve`, { notes });
export const rejectCase = (queueId, notes) => api.post(`/admin/cases/${queueId}/reject`, { notes });
export const requestMoreInfo = (queueId, message) => api.post(`/admin/cases/${queueId}/request-more-info`, { message });
export const downloadDocument = (practitionerId, documentId) => 
  api.get(`/admin/cases/${practitionerId}/documents/${documentId}/download`, { responseType: 'blob' });
export const freezePractitioner = (practitionerId, reason) => 
  api.post(`/admin/cases/practitioners/${practitionerId}/freeze`, { reason });

export const checkHealth = () => api.get('/health');
export default api;
```

---

## 9. SECURITY CONSIDERATIONS

1. **JWT Storage**: Store tokens in `localStorage` for simplicity in this MVP. The token has a 1-hour expiry.
2. **Admin Auth**: The admin dashboard must check for a valid admin token on mount. If missing or expired, redirect to `/admin/login`.
3. **CORS**: The backend already has `cors()` enabled globally.
4. **File Upload Limits**: Backend enforces 10MB max. Frontend should validate before upload.
5. **Input Validation**: Use Zod or manual validation on forms before sending to API.
6. **Error Handling**: Every API call must be wrapped in try/catch. Display user-friendly error messages, never expose raw error objects.
7. **No secrets in frontend code**: The `NEXT_PUBLIC_API_URL` is the only env var. All authentication flows use the backend JWT system.

---

## 10. DEPLOYMENT TO VERCEL

### Vercel Configuration
1. Push `frontend/` to a GitHub repo
2. Import in Vercel
3. Set root directory to `frontend`
4. Set environment variable: `NEXT_PUBLIC_API_URL` = your deployed backend URL
5. Build command: `npm run build`
6. Output directory: `.next`

### Important
- The backend (Node.js/Express + PostgreSQL) CANNOT run on Vercel
- Deploy backend to: Railway, Render, DigitalOcean App Platform, or a VPS
- Set CORS on backend to allow the Vercel frontend domain

---

## 11. TESTING CHECKLIST

Before considering the frontend complete, verify ALL of the following:

- [ ] `npm run build` completes with zero errors
- [ ] Landing page loads with animations at `localhost:3000`
- [ ] Clicking "Start Verification" navigates to `/verify`
- [ ] Step 1 button sends real POST to backend and creates a practitioner
- [ ] Step 2 consent checkbox enables the button, POST succeeds
- [ ] Step 3 file upload sends real FormData to backend
- [ ] Step 4 shows real trust score from `/v1/badge/:id/json`
- [ ] `/admin/login` authenticates and stores token
- [ ] `/admin` loads real queue data from `GET /admin/queue`
- [ ] `/admin/case/[id]` loads real case data
- [ ] Approve/Reject/Request More Info buttons work
- [ ] All animations are smooth (no janky transitions)
- [ ] No console errors in browser DevTools
- [ ] Responsive on mobile (min-width 375px)

---

## 12. KNOWN BACKEND ISSUES TO WORK AROUND

1. **The `POST /v1/practitioner/register` endpoint may not exist yet.** If it returns 404, the frontend should handle gracefully. You may need to check what registration endpoints exist by hitting `GET /health` first.
2. **RabbitMQ and Redis are optional.** The backend logs warnings about them but starts fine without them. Document processing (OCR) will be queued but may not process immediately without RabbitMQ.
3. **The `FROZEN` and `REJECTED` verification statuses** were added via ALTER TYPE but may not be in the original enum. If you see enum errors, that's a backend migration issue — frontend should just display whatever status string the API returns.
4. **Admin users must be seeded manually** in the `admin_users` table. The frontend cannot create admin accounts.
5. **The `EmailService.js` and `BadgeService.js`** files have been fixed with correct relative import paths (`../../shared/` instead of `../../../shared/`). Do not revert these.

---

*This document contains everything needed to build the TrustMed frontend from scratch. Follow it section by section. Do not skip steps. Do not improvise endpoints. Do not create mock data. Wire everything to the real backend.*
