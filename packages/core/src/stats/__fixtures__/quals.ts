/**
 * The real MSU qualifiers board, transcribed from the season spreadsheet's
 * QUALSCustomColors tab. Accuracy percentages exactly as the sheet shows them;
 * `null` means the player has no score on that map.
 *
 * This is the model's ground truth: a genuinely sparse matrix with genuine
 * fails in it (Kadence and Wyatt around 50% on Spin Eternally, Alex at 20% on
 * Madeleine), which is precisely the shape the engine has to survive.
 */
export const QUALS_MAPS = [
  'electric', // Electric Love    - Hard
  'casino', //   CASINO RAVE      - Hard
  'sentiment', // Sentiment       - Hard
  'madeleine', // Madeleine       - Easy
  'spin', //      Spin Eternally  - Expert  (the hardest by a distance)
  'konpeito', //  Konpeito Extremists
  'girlsnight', // Girls' Night
] as const;

export const QUALS_ACC: Record<string, Array<number | null>> = {
  //          electric casino sentiment madeleine spin   konpeito girlsnight
  cat: [96.44, 97.88, 97.54, 97.93, 90.46, 91.24, 95.08],
  treyo: [96.01, 96.9, 96.99, null, 89.56, 93.36, 93.39],
  will: [null, 97.85, 97.92, 98.38, null, null, null],
  mia: [96.29, 96.61, 96.68, 96.15, 70.97, 87.85, 93.9],
  kaiden: [null, null, 89.83, 96.73, 80.66, 86.59, 91.2],
  kadence: [95.73, 96.51, 95.49, 96.0, 50.45, 89.48, 92.7],
  wyatt: [96.31, 96.2, 96.64, 96.55, 51.53, 90.39, 86.9],
  alex: [95.36, 96.33, 96.2, 20.36, null, null, null],
  corn: [null, null, null, 97.52, 91.56, null, null],
  wynttter: [98.6, 99.02, null, null, null, null, null],
};

export interface QualsObservation {
  playerId: string;
  leaderboardId: string;
  acc: number;
}

export function qualsObservations(): QualsObservation[] {
  const out: QualsObservation[] = [];
  for (const [playerId, row] of Object.entries(QUALS_ACC)) {
    row.forEach((pct, i) => {
      if (pct == null) return;
      out.push({ playerId, leaderboardId: QUALS_MAPS[i]!, acc: pct / 100 });
    });
  }
  return out;
}
