import React, { useLayoutEffect, useRef } from 'react';
import { registerRoot, Composition, useCurrentFrame, AbsoluteFill } from 'remotion';
import { drawFrame, OUT_W, OUT_H } from './scene';

export const DURATION = 600;
const Nether: React.FC = () => {
  const frame = useCurrentFrame();
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current!.getContext('2d')!;
    drawFrame(ctx, frame / DURATION);
  }, [frame]);
  return <AbsoluteFill style={{ background: '#000' }}><canvas ref={ref} width={OUT_W} height={OUT_H} style={{ width: '100%', height: '100%' }} /></AbsoluteFill>;
};
const Root: React.FC = () => <Composition id="Nether" component={Nether} durationInFrames={DURATION} fps={30} width={OUT_W} height={OUT_H} />;
registerRoot(Root);
