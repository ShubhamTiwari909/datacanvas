/**
 * Sizes and spacing of a table node, in canvas units (1 unit = 1 pixel at zoom 1).
 *
 * The React component that draws a table node must use the SAME numbers, because
 * layout is computed BEFORE React Flow has measured anything (a new node needs a
 * position before it has ever been drawn). If the component's real height and
 * these estimates drift apart, nodes overlap or leave gaps.
 */
export const NODE_WIDTH = 280;
export const NODE_HEADER_HEIGHT = 40;
export const NODE_ROW_HEIGHT = 26;
/** Height of the "+ N more columns" footer shown on a collapsed wide table. */
export const NODE_FOOTER_HEIGHT = 30;

/** A collapsed table shows at most this many columns. */
export const COLLAPSED_COLUMN_LIMIT = 12;

/** Empty space kept between neighbouring nodes. */
export const NODE_GAP_X = 80;
export const NODE_GAP_Y = 60;
