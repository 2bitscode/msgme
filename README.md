# U2U

A tiny 2-person status + emergency-message web app. No build step — plain HTML/CSS/JS,
hosted for free on GitHub Pages. Live sync is powered by Firebase Realtime Database (free tier).

Messages are not stored: once the recipient taps "Got it", the message is deleted from the database.

## 1. Create a free Firebase project

1. Go to the Firebase console and sign in with a Google account, then create a new project
   (any name, e.g. "msgme"). Google Analytics is not needed — you can skip it.
2. In the project, open **Build -> Realtime Database** and click **Create Database**.
   - Choose any region.
   - Start in **locked mode** (we'll set custom rules in step 3).
3. Go to **Realtime Database -> Rules** and paste this, then click Publish:

   ```json
   {
     "rules": {
       "apps": {
         "$appHash": {
           ".read": true,
           ".write": true
         }
       }
     }
   }
   ```

   Note: this makes each `$appHash` path publicly readable/writable to anyone who knows it.
   The hash is derived from your shared PIN and isn't guessable in practice, but this is
   casual privacy, not bank-grade security — don't put anything truly sensitive through it.

4. Go to **Project settings** (gear icon) -> **General** -> scroll to "Your apps" -> click the
   **Web** icon (`</>`) to register a new web app (no Hosting needed). Copy the `firebaseConfig`
   object it gives you.

## 2. Configure the app

Open `firebase-config.js` in this folder and replace the placeholder values with the config
you copied above.

## 3. Put it on GitHub Pages

```
cd msgme_web
git init
git add .
git commit -m "Initial U2U app"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then in the GitHub repo: **Settings -> Pages -> Source: Deploy from a branch -> Branch: main / (root)**.
Your app will be live at `https://<your-username>.github.io/<repo-name>/`.

## 4. Using it on iPhone

1. Open the GitHub Pages URL in Safari.
2. Enter the shared PIN (agree on one number with the other person beforehand — it must match
   **exactly** on both phones, or you'll each be looking at a different empty "room").
3. Pick "U1" or "U2" (remembered on that phone from then on).
4. Optional but recommended: tap the Share icon -> **Add to Home Screen** so it opens full-screen
   like an app.

## Notes / limitations

- No push notifications: updates appear live only while the page is open. If the app isn't
  open, the other person won't see your message/status change until they open it.
- If your partner's status panel keeps showing "not set yet", the most common cause is a PIN
  mismatch between the two phones — double check you both typed the same PIN.
- To change the shared PIN or switch identity later, tap the log out icon (top right) — this
  clears the saved PIN and identity on that phone, so it'll ask for both again next time.
- Up to the last 10 unread messages are queued per person; they're replayed in order the next
  time that person opens the app, and each is deleted from the database once shown. If more
  than 10 pile up before it's opened, the oldest ones are dropped.
