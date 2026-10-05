# TractorBazaar

A simple marketplace for second-hand tractors. **Customers** post their tractor with photos; **brokers** log in separately to browse every posted tractor, view the photos and call the customer.

## Features

- Separate customer and broker accounts and login pages (the same mobile number can hold one of each)
- Customers post a tractor with brand, model, year, hours, expected price, location, description and photos from every angle (front, back, left, right, engine, dashboard & seat, tyres, other; one photo per angle, at least 4 in total)
- **Checked when posted**: the papers (RC book, insurance, owner ID proof, and a loan NOC if the tractor was bought on a loan) are added in the same form as the photos. Pressing Post (or Save after an edit) runs three checks in turn, shown step by step: the form is validated and saved; Claude looks at all the photos together once and compares them with the form (each shows a tractor at its angle, not copied from the internet, all the same tractor, matching the brand and model, the hour meter matching the hours, the description matching what is visible) and describes each photo for brokers' questions; then each new paper is read and checked. A failed step is shown with the reason; the listing stays saved, and the photo check can be rerun from it
- Customers see, edit and delete their own posts. Editing can change any detail and replace or remove the photo for any angle
- **AI assistant**: customers type or speak (Marathi, Hindi or English; the 🎤 button uses the browser's speech recognition, best in Chrome) and Claude fills the listing form in English
- **Verified papers**: Claude reads each paper; the app checks them against each other and the form (same vehicle, RC owner = ID name, make and year match, insurance not expired, no visible tampering). A listing is shown to brokers only when its photos and every required paper are verified
- Brokers see verified posts with photos and the customer's name and phone, plus search by brand, model or location, and can ask questions about a tractor's papers and photos (answered by Claude from the documents, stored as chunks with embeddings in Turso, and from the descriptions written during the photo check)
- Photos are private: only brokers and the customer who uploaded them can view them
- Data is stored in SQLite: a local file on your computer, or a hosted [Turso](https://turso.tech) database on Vercel. Photos go in the `uploads/` folder locally, or a private Vercel Blob store on Vercel

## Tech

- Node.js 22 with Express 5
- SQLite via `@libsql/client` (local file or Turso), so there is no database server to install
- React 19 + React Router in `client/`, built with Vite into `dist/`
- Logins use a JWT in an httpOnly cookie and passwords are hashed with bcrypt
- Claude Sonnet 5.5 (`claude-sonnet-5-5`) for the chat, reading documents and answering questions, limited to the listing, its photos and papers (off-topic answers are replaced by the server); Voyage AI (`voyage-4`) embeddings stored in Turso's native vector columns

## Run it

```bash
npm install
npm run dev          # http://localhost:5173 — React app with hot reload + the API on the same port
npm run build        # build the React app into dist/
npm start            # http://localhost:3000 — serves the API and the built app from dist/
npm test             # API tests
```

Open the app, pick **Customer** or **Broker**, and sign up. `npm run dev` runs the Express API inside the Vite dev server; restart it after changing files in `src/`.

### Configuration (environment variables)

| Variable     | Default           | Notes                              |
|--------------|-------------------|------------------------------------|
| `PORT`       | `3000`            |                                    |
| `DB_PATH`    | `./tractors.db`   | SQLite file, created automatically (ignored when `TURSO_DATABASE_URL` is set) |
| `UPLOAD_DIR` | `./uploads`       | Where photos are stored (ignored when `BLOB_READ_WRITE_TOKEN` is set) |
| `JWT_SECRET` | dev-only value    | **Required** when `NODE_ENV=production` |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | – | Use a Turso database instead of the local file. **Required** on Vercel |
| `BLOB_READ_WRITE_TOKEN` | – | Store photos in Vercel Blob instead of `uploads/`. **Required** on Vercel |
| `ANTHROPIC_API_KEY` | – | Claude, for the assistant and document checks ([console.anthropic.com](https://console.anthropic.com)). Without it the site works but these features say they are not set up |
| `VOYAGE_API_KEY` | – | Voyage AI embeddings for document search ([voyageai.com](https://www.voyageai.com)) |

## Deploy on Vercel

On Vercel there is no `npm start`: `api/index.js` runs the Express app as a serverless function, and `vercel.json` builds the React app (`npm run build`), serves `dist/` as static files, sends `/api/*` and `/uploads/*` to that function, and sends every other path to `index.html` so React can show the right page. Vercel servers keep no files between requests, so the database and photos must live in hosted storage:

1. Import the GitHub repo in Vercel (`vercel.json` sets the build command and output folder).
2. **Storage → Create → Blob**: choose **Private** access and connect it to the project. This adds `BLOB_READ_WRITE_TOKEN`.
3. **Storage → Marketplace → Turso** (or create a database at turso.tech): connect it to the project. This should add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`; if you created the database on turso.tech, add those two yourself under Settings → Environment Variables.
4. **Settings → Environment Variables**: add `JWT_SECRET` set to any long random text, plus `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`.
5. Redeploy (Deployments → ⋯ → Redeploy). The tables are created automatically on the first request.

Vercel accepts at most 4.5 MB per request, so the customer page shrinks photos in the browser (to about 1400 px) before uploading.

## Project layout

```
api/
  index.js    Vercel entry point
src/
  index.js    local server start-up (npm start)
  setup.js    builds the app from environment variables
  storage.js  photo storage: local folder or Vercel Blob
  app.js      routes: auth, tractors, photo serving
  auth.js     cookie/JWT helpers and role checks
  ai.js       Claude and Voyage calls: chat-to-form, reading documents, answers, embeddings, chunking
  verify.js   rules that decide whether a listing's papers are verified
  db.js       database connection and schema (users, tractors, photos, documents, doc_chunks)
client/                 React app (built into dist/)
  index.html
  src/
    main.jsx            routes
    api.js              fetch helper, formatting, photo shrinking
    auth.js             login check hooks
    style.css
    components/         Header, TractorCard, PhotoSlots, Lightbox, Assistant (chat + voice), PaperSlots, CheckProgress (the step-by-step checks), Verification, AskDocuments
    pages/
      Home.jsx          landing page (choose customer or broker)
      Login.jsx         /login?role=customer | broker
      Register.jsx      /register?role=customer | broker
      Customer.jsx      /customer: post / edit a tractor + my posts
      Broker.jsx        /broker: all customer posts with photos
test/app.test.js
vite.config.js
vercel.json
```

## API

| Method | Path                   | Who      | Purpose                                  |
|--------|------------------------|----------|------------------------------------------|
| POST   | `/api/auth/register`   | anyone   | `{ name, phone, password, role }`        |
| POST   | `/api/auth/login`      | anyone   | `{ phone, password, role }`              |
| POST   | `/api/auth/logout`     | anyone   |                                          |
| GET    | `/api/auth/me`         | logged in|                                          |
| POST   | `/api/tractors`        | customer | multipart form; one photo per angle in fields `photo_front`, `photo_rear`, `photo_left`, `photo_right`, `photo_engine`, `photo_dashboard`, `photo_tyres`, `photo_other` |
| PUT    | `/api/tractors/:id`    | customer | edit own post: same form, photos optional (a new photo replaces that angle's photo), `removePhotoIds` = comma-separated photo ids to delete |
| GET    | `/api/tractors/mine`   | customer | own posts                                |
| DELETE | `/api/tractors/:id`    | customer | own post (removes its photos too)        |
| GET    | `/api/tractors?q=`     | broker   | verified posts with photos and contact   |
| POST   | `/api/assistant/form`  | customer | `{ messages: [{role, content}], form }` → `{ reply, fields }` |
| POST   | `/api/tractors/:id/photos/check` | customer | step 2 of posting or saving: check the photos against the form |
| PUT    | `/api/tractors/:id/documents/:type` | customer | step 3: upload `file` (photo or PDF, ≤ 4 MB); type is `rc`, `insurance`, `loan_noc` or `owner_id` |
| POST   | `/api/tractors/:id/ask` | broker or owner | `{ question }` → `{ answer }` from the papers |
| GET    | `/uploads/:file`       | broker or owner | photo file (document files: owner only) |
