# Timeline Viewer (web)

Static site: no build step, no server code. Your timeline file is read in the browser and never uploaded anywhere.

## Put it on GitHub Pages
1. Create a new GitHub repo (e.g. `timeline`) and upload everything in this folder to the repo root.
2. Repo Settings > Pages > Build and deployment > Source: "Deploy from a branch", Branch: `main`, folder `/ (root)`. Save.
3. After a minute it's live at `https://<your-username>.github.io/<repo>/`.

Do NOT commit your Timeline.json to the repo. Open it from the page with the Open... button instead.

## Notes
- The last file you open is kept in that browser (IndexedDB) so it reopens instantly. Use "Forget" on shared PCs.
- Corrected places are stored per browser. Use Saved places > Export / Import to move them between devices.
