# Dés-IA

Retravaille un titre généré par IA pour qu'il cesse de ressembler à un rendu machine. Le traitement tourne dans le navigateur : le fichier ne quitte pas l'appareil, sauf si tu lances l'analyse avancée.

En ligne : https://desia-nine.vercel.app

## Ce que ça fait

Chaîne de traitement local sur l'audio décodé :

1. micro-timing (deux couches de flottement sur les attaques)
2. dérive de hauteur lente, en cents
3. cinq creux fins dans les aigus, là où se logent les pics laissés par les générateurs
4. exciter à saturation douce, avec shelf de compensation
5. variation de niveau lente
6. bruit de pièce filtré et modulé
7. retard stéréo léger
8. limiteur, normalisation à la crête d'origine

Sortie WAV 24 bits, 44,1 ou 48 kHz. Un lecteur compare l'original et le résultat au même endroit (bascule A/B).

## Analyse du titre (dans le navigateur)

[Essentia.js](https://github.com/MTG/essentia.js) (WebAssembly, dans un Web Worker) mesure l'original puis le résultat : tempo, tonalité, loudness intégrée EBU R128, plage de loudness, complexité dynamique. Rien n'est envoyé.

Cette mesure sert aussi de garde-fou : un traitement qui change la tonalité ou le tempo se voit tout de suite.

## Analyse avancée (sur serveur, à la demande)

Bouton séparé, avec envoi du fichier au serveur. Le fichier et les résultats sont effacés une heure après l'analyse. Détails d'installation : [server/README.md](server/README.md).

| Repo | Ce qu'il analyse | Stars (6 nov. 2026) | Licence | Lien |
|---|---|---|---|---|
| Essentia | BPM, tonalité, mood, genre, danceability | 3 794 | AGPL-3.0 (modèles : CC BY-NC-SA 4.0) | https://github.com/MTG/essentia |
| librosa | Base Python : tempo, spectre, timbre | 8 802 | ISC | https://github.com/librosa/librosa |
| Demucs | Sépare voix, basse, drums, reste | 3 502 | MIT | https://github.com/adefossez/demucs |
| All-In-One | Beats, mesures, sections (intro, drop…) | 880 | MIT | https://github.com/mir-aidj/all-in-one |
| Basic Pitch | Audio vers MIDI (mélodies, accords) | 6 026 | Apache-2.0 | https://github.com/spotify/basic-pitch |
| Audio Flamingo | IA qui décrit un morceau en texte | 1 219 | Poids : licence NVIDIA non commerciale | https://github.com/NVIDIA/audio-flamingo |

## Honnêteté sur les résultats

Sur un morceau de test (Suno, 99,3 % IA chez ACRCloud), trois traitements passés seuls — transposition aller-retour, rééchantillonnage à 22 kHz, exciter — n'ont pas déplacé le score d'un point. L'outil les combine et ajoute ce qui n'a pas été testé (flottement de timing, bruit de pièce). Rien ne garantit un passage : rejouer la voix ou des instruments reste le levier solide. Les mesures d'analyse décrivent le son ; elles ne prédisent pas le verdict d'un détecteur.

## Développement

```bash
pnpm install
pnpm dev
pnpm build
```

Traitement en `OfflineAudioContext`, export PCM maison.

## Licence

AGPL-3.0, car le site embarque Essentia.js (AGPL-3.0). Voir [LICENSE](LICENSE).
