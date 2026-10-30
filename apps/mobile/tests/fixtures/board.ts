import type { BoardView } from '@puzzle-sns/contracts';
export const artificialBoard: BoardView = {
  boardId: 'synthetic-board',
  dayKey: '2026-10-28',
  version: 1,
  pieces: [
    {
      id: 'synthetic-piece',
      position: { x: 0, y: 0 },
      edges: {
        north: 'round-out',
        east: 'round-in',
        south: 'square-out',
        west: 'square-in',
      },
      visibility: 'visible',
      photoRef: 'normalized/synthetic-piece/image',
      username: '人工署名',
      caption: '人工図形',
    },
  ],
};
