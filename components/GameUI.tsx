
import React from 'react';
import { GameState, LevelData } from '../types';

interface GameUIProps {
  gameState: GameState;
  playerHealth: number;
  playerMaxHealth: number;
  bossHealth: number;
  bossMaxHealth: number;
  stamina: number;
  levelData: LevelData | null;
  score: number;
  onStart: () => void;
  onRestart: () => void;
}

const GameUI: React.FC<GameUIProps> = ({
  gameState,
  playerHealth,
  playerMaxHealth,
  bossHealth,
  bossMaxHealth,
  stamina,
  levelData,
  score,
  onStart,
  onRestart
}) => {
  const healthPercent = Math.max(0, (playerHealth / playerMaxHealth) * 100);
  const bossHealthPercent = Math.max(0, (bossHealth / bossMaxHealth) * 100);
  const staminaPercent = Math.max(0, stamina); // Assuming stamina is 0-100

  if (gameState === GameState.MENU) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 z-50 text-center p-4">
        <h1 className="text-6xl md:text-8xl font-bold text-yellow-600 mb-4 tracking-widest font-serif drop-shadow-[0_0_10px_rgba(234,179,8,0.5)]">
          PIXEL MYTH
        </h1>
        <h2 className="text-3xl text-gray-400 mb-8 tracking-widest">WUKONG</h2>
        <button
          onClick={onStart}
          className="px-8 py-3 border-2 border-yellow-700 text-yellow-600 text-xl hover:bg-yellow-900/30 hover:text-yellow-400 transition-all duration-300 tracking-widest uppercase"
        >
          Reawaken Destiny
        </button>
      </div>
    );
  }

  if (gameState === GameState.LOADING) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-50">
        <div className="animate-pulse text-yellow-800 text-2xl font-serif tracking-widest">
          Consulting the Scrolls...
        </div>
      </div>
    );
  }

  if (gameState === GameState.GAME_OVER || gameState === GameState.VICTORY) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-50">
        <h2 className={`text-6xl font-serif mb-6 ${gameState === GameState.VICTORY ? 'text-yellow-500' : 'text-red-800'}`}>
          {gameState === GameState.VICTORY ? 'VICTORY' : 'DEFEAT'}
        </h2>
        <p className="text-gray-400 mb-8 text-xl">Destiny awaits another cycle.</p>
        <button
          onClick={onRestart}
          className="px-8 py-3 border border-gray-500 text-gray-300 hover:bg-gray-800 transition-all uppercase tracking-wider"
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 pointer-events-none p-4 flex flex-col justify-between z-10">
      {/* Top Bar: Player Stats */}
      <div className="flex justify-between items-start w-full max-w-5xl mx-auto">
        <div className="flex flex-col gap-2 w-64">
           {/* Health */}
          <div className="relative h-4 bg-gray-900 border border-gray-700">
            <div
              className="h-full bg-gradient-to-r from-red-900 to-red-600 transition-all duration-200"
              style={{ width: `${healthPercent}%` }}
            />
          </div>
          {/* Stamina */}
          <div className="relative h-2 bg-gray-900 border border-gray-700 w-3/4">
            <div
              className="h-full bg-yellow-600 transition-all duration-200"
              style={{ width: `${staminaPercent}%` }}
            />
          </div>
          <div className="text-yellow-700 text-xs font-serif tracking-widest uppercase mt-1">
            Destined One
          </div>
        </div>

        {/* Score / Chapter */}
        <div className="text-center">
          <h3 className="text-gray-500 text-xs tracking-[0.2em] uppercase">{levelData?.chapterTitle}</h3>
          <div className="text-yellow-900/50 text-4xl font-serif font-bold">{score}</div>
        </div>
      </div>

      {/* Bottom: Boss Health (if exists) */}
      {bossHealth > 0 && (
        <div className="w-full max-w-3xl mx-auto mb-8">
          <div className="flex justify-between text-gray-400 text-sm mb-1 font-serif tracking-widest uppercase">
            <span>{levelData?.bossName || "Unknown Demon"}</span>
            <span className="text-xs text-gray-600">{Math.ceil(bossHealth)} / {bossMaxHealth}</span>
          </div>
          <div className="h-3 bg-gray-900 border border-gray-600">
             <div
              className="h-full bg-purple-900 transition-all duration-200"
              style={{ width: `${bossHealthPercent}%` }}
            />
          </div>
        </div>
      )}
      
      {/* Intro Text Overlay (Fades out) */}
      {gameState === GameState.PLAYING && levelData && score < 10 && (
        <div className="absolute top-1/4 left-0 right-0 flex justify-center animate-[fadeOut_5s_forwards] pointer-events-none">
          <div className="bg-black/50 backdrop-blur-sm rounded-lg p-4 max-w-xl border border-yellow-900/30">
            <p className="text-yellow-100/90 text-lg italic font-serif text-center drop-shadow-md">
              "{levelData.introText}"
            </p>
          </div>
        </div>
      )}

      {/* Controls Overlay */}
      <div className="absolute bottom-4 right-4 text-gray-500 text-[10px] md:text-xs font-serif bg-black/60 p-3 border border-gray-800 rounded backdrop-blur-sm pointer-events-none">
        <div className="flex flex-col gap-1">
            <div className="flex justify-between gap-4"><span className="text-yellow-700 font-bold">AD</span> <span>Move</span></div>
            <div className="flex justify-between gap-4"><span className="text-yellow-700 font-bold">Space</span> <span>Jump</span></div>
            <div className="flex justify-between gap-4"><span className="text-yellow-700 font-bold">J</span> <span>Attack</span></div>
            <div className="flex justify-between gap-4"><span className="text-yellow-700 font-bold">Hold J</span> <span>Heavy</span></div>
            <div className="flex justify-between gap-4"><span className="text-yellow-700 font-bold">K</span> <span>Cloud Strike</span></div>
            <div className="flex justify-between gap-4"><span className="text-yellow-700 font-bold">L / Shift</span> <span>Dodge</span></div>
            <div className="flex justify-between gap-4"><span className="text-yellow-700 font-bold">I</span> <span>Immobilize</span></div>
            <div className="flex justify-between gap-4"><span className="text-yellow-700 font-bold">Hold N</span> <span>Setsugekka</span></div>
        </div>
      </div>

    </div>
  );
};

export default GameUI;