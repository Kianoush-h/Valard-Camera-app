# Valard Camera

Timestamp camera web app for Valard crews. Take a photo, check the stamp, tap **Approve**.
The photo is uploaded to the SharePoint **Photos** library (site `VLD-67720009077`) into a folder named by date, e.g. `2026-10-17`.

Each photo is stamped with:
- Network and local date/time with time zone
- GPS coordinates (degrees / minutes / seconds)
- Compass heading (e.g. `273° W`)
- Street address
- Satellite mini-map with your position
- Compass rose
- Photographer name

Developed by Kianoush Haratiannejadi.

**App link:** https://kianoush-h.github.io/Valard-Camera-app/

---

## For crew members: install on iPhone

1. Open the app link above in **Safari** (it must be Safari).
2. Tap **Share** (square with arrow) → **Add to Home Screen** → **Add**.
3. Open **Valard Cam** from the home screen.
4. Enter your name and the **team code** (ask Kianoush). You only do this once.
5. Allow **Location** and **Compass** (Motion & Orientation) when asked.
6. Tap the white button, take the photo, tap **Use Photo**, then **Approve & upload**.

No signal? Photos wait on the phone and upload automatically next time the app is open with signal.

---

## Admin setup (one time)

### 1. Power Automate flow

1. Go to <https://make.powerautomate.com> → **Create** → **Instant cloud flow** → name it `Valard Camera Upload` → choose **When an HTTP request is received** → **Create**.
2. In the trigger:
   - **Who can trigger the flow?** → **Anyone**
   - **Method** → `POST`
   - **Request Body JSON Schema** → paste:
     ```json
     {
       "type": "object",
       "properties": {
         "pin":      { "type": "string" },
         "folder":   { "type": "string" },
         "filename": { "type": "string" },
         "user":     { "type": "string" },
         "takenAt":  { "type": "string" },
         "address":  { "type": "string" },
         "content":  { "type": "string" }
       }
     }
     ```
3. **+ New step → Condition**: `pin` (from the trigger) **is equal to** your Team PIN (pick something 6+ characters, e.g. `Vld-4821`).
4. In **True**:
   - **SharePoint → Create file**
     - Site Address: `https://quantaservices.sharepoint.com/sites/VLD-67720009077`
     - Folder Path: type `/Photos/` then insert dynamic content **folder**
     - File Name: dynamic content **filename**
     - File Content: **Expression** → `base64ToBinary(triggerBody()?['content'])`
   - **Request → Response**: Status Code `200`, Body `{"ok":true}`
5. In **False**:
   - **Request → Response**: Status Code `401`, Body `{"ok":false}`
6. **Save**. Open the trigger again and copy the **HTTP URL**.

> The date folder is created automatically by *Create file* if it does not exist yet.

### 2. Team codes (add / remove without touching code)

The flow URL contains a secret signature (`sig=`), so it is never stored in this repo in plain form.
`pins.txt` holds one line per team code: the URL encrypted with that code. The app accepts a code if it unlocks a line.

**Add a code**
1. In the flow's **Condition**, add the code (conditions joined with **OR**) and save.
2. Open <https://kianoush-h.github.io/Valard-Camera-app/admin.html>, paste the flow URL and the new code, tap **Create line**.
3. Tap **Copy line**, then **Open pins.txt** on GitHub, paste it on a new line at the bottom, **Commit changes**.

**Remove a code:** delete its line in `pins.txt` and remove it from the flow. Phones using it are signed out the next time they open the app.

Without a valid code the app shows **NOT CONNECTED** and approved photos go to the iPhone share sheet (Save Image) instead.

### 3. GitHub Pages

Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch `main`, folder `/ (root)` → **Save**.

---

## Notes

- Use a team code of 8+ characters with letters and numbers: the encrypted URL is public, so a short code could be guessed offline.
- The stamp is drawn on the phone; photos only go to the Power Automate flow. Address lookup uses OpenStreetMap Nominatim, map tiles use Esri World Imagery.
- To ship an update, bump `VERSION` in `config.js`.
