import React, { useState } from 'react';
import GameCanvas from './components/GameCanvas';
import GameUI from './components/GameUI';
import { GameState, LevelData } from './types';
import { generateLevelLore } from './services/geminiService';

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(GameState.MENU);
  const [levelData, setLevelData] = useState<LevelData | null>(null);
  
  // UI State
  const [playerHealth, setPlayerHealth] = useState(100);
  const [bossHealth, setBossHealth] = useState(500);
  const [stamina, setStamina] = useState(100);
  const [score, setScore] = useState(0);

  const handleStartGame = async () => {
    setGameState(GameState.LOADING);
    
    // Generate Level Data via Gemini
    const data = await generateLevelLore();
    setLevelData(data);
    
    setGameState(GameState.PLAYING);
  };

  const handleRestart = () => {
    setGameState(GameState.LOADING);
    // Small timeout to simulate reset
    setTimeout(() => {
        setGameState(GameState.PLAYING);
    }, 500);
  };

  return (
    <div className="w-screen h-screen bg-zinc-950 flex items-center justify-center overflow-hidden relative">
      {/* CRT Filter Effect */}
      <div className="absolute inset-0 z-40 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] opacity-20"></div>
      
      <div className="relative w-full max-w-[1000px] aspect-video bg-black shadow-[0_0_50px_rgba(0,0,0,0.8)] border-4 border-[#1a1a1a] rounded-lg overflow-hidden">
        
        <GameCanvas 
          gameState={gameState}
          setGameState={setGameState}
          setPlayerHealth={setPlayerHealth}
          setBossHealth={setBossHealth}
          setStamina={setStamina}
          setScore={setScore}
        />

        <GameUI 
          gameState={gameState}
          playerHealth={playerHealth}
          playerMaxHealth={100}
          bossHealth={bossHealth}
          bossMaxHealth={500}
          stamina={stamina}
          levelData={levelData}
          score={score}
          onStart={handleStartGame}
          onRestart={handleRestart}
        />
      </div>
    </div>
  );
};

export default App;
