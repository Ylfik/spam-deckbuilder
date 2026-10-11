# Atelier SPAM — deck builder

Deck builder non officiel pour le jeu de cartes **SPAM** (Ticroco) : construction de deck, simulation tour par tour, recherche du meilleur deck selon ta collection, méta calculée par grand tournoi, tier list et liste de tous les effets du jeu.

**[➜ Ouvrir l’Atelier SPAM](https://ylfik.github.io/spam-deckbuilder/)**

## Overlay en jeu (Windows)

**[➜ Télécharger Overlay-SPAM.exe](https://github.com/Ylfik/spam-deckbuilder/releases/latest/download/Overlay-SPAM.exe)** — aucun installateur, double-clic pour le lancer.

Un calque transparent au-dessus du jeu : tes cartes et celles de l’adversaire, la **cible principale** à attaquer, tes cartes à protéger, ta chance de victoire estimée, et les taux de la boutique selon la chance (relevés automatiquement dans tes replays après chaque partie).

- `Ctrl+Maj+D` : déplacer l’overlay / cliquer dedans (corriger les cartes adverses) — refais-le pour le verrouiller
- `Ctrl+Maj+S` : masquer / afficher (aussi depuis l’icône près de l’horloge)
- Joue en **plein écran fenêtré** (sans bordure) : en plein écran exclusif, Windows cache tout calque.
- L’overlay lit seulement les fichiers que le jeu écrit déjà (`Player.log` et les replays dans `AppData\LocalLow\Ticroco\Spam`) : il ne touche ni au jeu ni au réseau.

Code dans [`overlay/`](overlay/).

## Site

Tout tient dans `index.html` (images incluses). La sauvegarde (collection, deck) reste dans le navigateur de chaque visiteur.

Projet non officiel, sans lien avec Ticroco. Données, cadres et illustrations issus du Spamdex officiel (spamgame.com), repris selon ses conditions d'utilisation.
