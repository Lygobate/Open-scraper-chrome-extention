# Privacy Policy – Open Scraper

*Last updated: October 30, 2026*

## English

Open Scraper is a browser extension that extracts tabular data from the web page the user is viewing and lets the user export it as a CSV or Excel file.

**Open Scraper does not collect, transmit, sell or share any user data.** The extension has no server, no analytics, no advertising and no tracking. It makes no network requests of its own.

### What the extension accesses
- **Web page content**: when the user starts a scraping session, the extension reads the text and links of the tables/lists on the active page. This data is processed locally in the browser and is only used to display the results and to produce the file the user chooses to export. It is never sent anywhere.
- **Network activity (webRequest)**: used in read-only mode to count the pending requests of the tab being scraped, so the extension knows when a new page has finished loading. Request contents, headers and URLs are not read, stored or transmitted.
- **Tabs**: used to identify the active tab and its site hostname, and to communicate with the page being scraped.

### What the extension stores
The extension stores, locally in the browser only (`chrome.storage.local` and `localStorage`), the user's own settings: column and crawl settings per website, page details templates, the selector of the "Next" button, and a short history of content hashes used to detect that a table has changed. This data never leaves the device and can be erased by removing the extension or clearing its data.

### Remote code
All code is bundled in the extension package. No remote code is loaded or executed.

### Third parties
No data is shared with third parties.

### Changes
Any change to this policy will be published in this file.

### Contact
Open an issue at https://github.com/Lygobate/Open-scraper-chrome-extention/issues

---

## Français

Open Scraper est une extension de navigateur qui extrait les données tabulaires de la page web consultée et permet de les exporter en fichier CSV ou Excel.

**Open Scraper ne collecte, ne transmet, ne vend et ne partage aucune donnée utilisateur.** L'extension n'a pas de serveur, aucun outil d'analyse, aucune publicité et aucun suivi. Elle n'effectue aucune requête réseau pour son propre compte.

### Ce à quoi l'extension accède
- **Contenu des pages web** : lorsque l'utilisateur lance une extraction, l'extension lit le texte et les liens des tableaux/listes de la page active. Ces données sont traitées localement dans le navigateur et servent uniquement à afficher les résultats et à produire le fichier que l'utilisateur choisit d'exporter. Elles ne sont envoyées nulle part.
- **Activité réseau (webRequest)** : utilisée en lecture seule pour compter les requêtes en cours de l'onglet extrait, afin de savoir quand une nouvelle page a fini de charger. Le contenu, les en-têtes et les URL des requêtes ne sont ni lus, ni stockés, ni transmis.
- **Onglets** : utilisés pour identifier l'onglet actif et le nom d'hôte du site, et pour communiquer avec la page extraite.

### Ce que l'extension stocke
L'extension stocke, uniquement en local dans le navigateur (`chrome.storage.local` et `localStorage`), les réglages de l'utilisateur : préréglages d'extraction par site, sélecteur du bouton « Suivant » et un court historique d'empreintes de contenu servant à détecter qu'un tableau a changé. Ces données ne quittent jamais l'appareil et s'effacent en supprimant l'extension ou ses données.

### Code distant
Tout le code est inclus dans le package de l'extension. Aucun code distant n'est chargé ni exécuté.

### Tiers
Aucune donnée n'est partagée avec des tiers.

### Modifications
Toute modification de cette politique sera publiée dans ce fichier.

### Contact
Ouvrir une issue sur https://github.com/Lygobate/Open-scraper-chrome-extention/issues
