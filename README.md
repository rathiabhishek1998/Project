# TractorBazaar

A simple marketplace for second-hand tractors. **Customers** post their tractor with photos; **brokers** log in separately to browse every posted tractor, view the photos and call the customer.

## Features

- Separate customer and broker accounts and login pages (the same mobile number can hold one of each)
- Customers post a tractor with brand, model, year, hours, expected price, location, description and photos from every angle (front, back, left, right, engine, dashboard & seat, tyres, other; one photo per angle, at least one in total)
- Customers see, edit and delete their own posts. Editing can change any detail and replace or remove the photo for any angle
- Brokers see all customer posts with photos and the customer's name and phone, plus search by brand, model or location
- Photos are private: only brokers and the customer who uploaded them can view them
- Data is stored in SQLite (Node's built-in `node:sqlite`) and photos in the `uploads/` folder

## Tech

- Node.js 22.13+ with Express 5
- SQLite via `node:sqlite`, so there is no database server to install
- Plain HTML, CSS and JavaScript in `public/`, so there is no frontend build step
- Logins use a JWT in an httpOnly cookie and passwords are hashed with bcrypt

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm run dev          # same, restarts on file changes
npm test             # API tests
```

Open http://localhost:3000, pick **Customer** or **Broker**, and sign up.

### Configuration (environment variables)

| Variable     | Default           | Notes                              |
|--------------|-------------------|------------------------------------|
| `PORT`       | `3000`            |                                    |
| `DB_PATH`    | `./tractors.db`   | SQLite file, created automatically |
| `UPLOAD_DIR` | `./uploads`       | Where photos are stored            |
| `JWT_SECRET` | dev-only value    | **Required** when `NODE_ENV=production` |

## Project layout

```
src/
  index.js    server start-up and config
  app.js      routes: auth, tractors, photo serving
  auth.js     cookie/JWT helpers and role checks
  db.js       SQLite schema (users, tractors, photos)
public/
  index.html      landing page (choose customer or broker)
  login.html      login (?role=customer | ?role=broker)
  register.html   sign up (?role=customer | ?role=broker)
  customer.html   post / edit a tractor + my posts
  broker.html     all customer posts with photos
  common.js, style.css
test/app.test.js
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
| GET    | `/api/tractors?q=`     | broker   | all posts with photos and contact        |
| GET    | `/uploads/:file`       | broker or owner | photo file                        |
