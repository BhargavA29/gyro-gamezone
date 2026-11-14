import type { PlayerSlotState } from "@gyro/shared";

/**
 * Renders a crisp 1200x675 arcade standings card on an offscreen Canvas
 * so players can download or share a PNG trophy card without any external service.
 */
export async function renderShareableResultCard(
  gameTitle: string,
  roomCode: string,
  sortedPlayers: readonly PlayerSlotState[],
): Promise<{ dataUrl: string; blob: Blob | null }> {
  const width = 1200;
  const height = 675;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return { dataUrl: "", blob: null };

  // Matte obsidian backdrop + crisp geometric arcade rules
  ctx.fillStyle = "#0d0f14";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#1d2330";
  ctx.lineWidth = 2;
  for (let x = 60; x < width; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // Top accent bar + header
  ctx.fillStyle = "#ff4d2e";
  ctx.fillRect(56, 48, 84, 8);

  ctx.fillStyle = "#a6b1c3";
  ctx.font = '600 22px "Space Grotesk Variable", ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(`GYRO-GAMEZONE · ROOM ${roomCode}`, 56, 94);

  ctx.fillStyle = "#f1f4f9";
  ctx.font = '700 52px "Space Grotesk Variable", ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(gameTitle, 56, 156);

  // Player podium rows
  const maxRows = Math.min(4, sortedPlayers.length);
  for (let i = 0; i < maxRows; i++) {
    const p = sortedPlayers[i]!;
    const y = 205 + i * 102;
    const isWinner = i === 0;

    ctx.fillStyle = isWinner ? "#1d2330" : "#151922";
    ctx.fillRect(56, y, width - 112, 84);

    ctx.strokeStyle = isWinner ? p.colorHex : "rgba(241, 244, 249, 0.14)";
    ctx.lineWidth = isWinner ? 3 : 1.5;
    ctx.strokeRect(56, y, width - 112, 84);

    ctx.fillStyle = p.colorHex;
    ctx.fillRect(56, y, 10, 84);

    ctx.fillStyle = "#a6b1c3";
    ctx.font = '700 30px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText(`#${i + 1}`, 92, y + 52);

    ctx.fillStyle = "#f1f4f9";
    ctx.font = '600 32px "Space Grotesk Variable", ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(p.name, 164, y + 52);

    const scoreStr = `${p.score.toLocaleString()} pts`;
    ctx.font = '700 34px "JetBrains Mono", ui-monospace, monospace';
    const metrics = ctx.measureText(scoreStr);
    ctx.fillStyle = isWinner ? p.colorHex : "#f1f4f9";
    ctx.fillText(scoreStr, width - 88 - metrics.width, y + 53);
  }

  // Footer
  ctx.fillStyle = "#828ea3";
  ctx.font = '500 20px "Plus Jakarta Sans Variable", ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(
    `Played locally over WebSockets · ${new Date().toLocaleDateString()}`,
    56,
    height - 34,
  );

  const dataUrl = canvas.toDataURL("image/png");
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });
  return { dataUrl, blob };
}
