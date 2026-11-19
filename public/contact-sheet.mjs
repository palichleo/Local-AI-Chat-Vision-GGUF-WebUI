/**
 * (0.6.112) Several takes on one picture, each under its number, for the chat model to look at them
 * together. Asked to plan a video from three takes, the local model asked to look at the three in
 * one message (which may hold one tool: the turn was lost, 19/11), then looked at them one by one:
 * a request and a picture for each, where the default context holds 8 192 tokens. One call now
 * names them all (lib/output-tools.mjs), and they come back as one picture, whatever their count.
 */

/** How many takes a sheet holds: three rows of four, each still large enough to be told apart. */
export const SHEET_TAKES = 12;

/**
 * Where each take goes. The fewest rows of at most four columns; each cell is a strip for its
 * number (`label` px) over a square of `cell` px its picture is fitted in.
 */
export function sheetLayout(count, { cell = 320, gap = 8, label = 34 } = {}) {
  const shown = Math.max(1, Math.min(SHEET_TAKES, Math.floor(count) || 1)),
    columns = shown <= 3 ? shown : shown === 4 ? 2 : shown <= 6 ? 3 : 4,
    rows = Math.ceil(shown / columns);
  return {
    columns,
    rows,
    cell,
    label,
    width: columns * cell + (columns + 1) * gap,
    height: rows * (cell + label) + (rows + 1) * gap,
    cells: Array.from({ length: shown }, (_, at) => ({
      x: gap + (at % columns) * (cell + gap),
      y: gap + Math.floor(at / columns) * (cell + label + gap),
    })),
  };
}

function loadPicture(url) {
  return new Promise((yes, no) => {
    const picture = new Image();
    picture.onload = () => yes(picture);
    picture.onerror = () => no(new Error('Image illisible.'));
    picture.src = url;
  });
}

/**
 * The sheet of `items` ([{ label, url }], the first SHEET_TAKES of them), as the address of a JPEG
 * (« data: »). A picture that cannot be read leaves its cell empty under its number.
 */
export async function contactSheet(items, { document = globalThis.document, load = loadPicture } = {}) {
  const shown = items.slice(0, SHEET_TAKES),
    layout = sheetLayout(shown.length),
    canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const pen = canvas.getContext('2d');
  pen.fillStyle = '#101012';
  pen.fillRect(0, 0, layout.width, layout.height);
  pen.textBaseline = 'middle';
  for (const [at, item] of shown.entries()) {
    const { x, y } = layout.cells[at],
      top = y + layout.label;
    pen.fillStyle = '#ffffff';
    pen.font = '600 22px sans-serif';
    pen.fillText(String(item.label), x + 4, y + layout.label / 2);
    pen.fillStyle = '#1c1c20';
    pen.fillRect(x, top, layout.cell, layout.cell);
    try {
      const picture = await load(item.url),
        scale = Math.min(layout.cell / picture.width, layout.cell / picture.height),
        width = Math.round(picture.width * scale),
        height = Math.round(picture.height * scale);
      pen.drawImage(picture, x + (layout.cell - width) / 2, top + (layout.cell - height) / 2, width, height);
    } catch {
      // Left empty under its number: the other takes are still worth showing.
    }
  }
  return canvas.toDataURL('image/jpeg', 0.86);
}
