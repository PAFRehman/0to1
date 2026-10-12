import type { StoryScene } from './story'
export const defaultCopy = {
  global:{brand:'PenguMint',loading:'Opening your little onchain world',playMusic:'Play music',muteMusic:'Mute music',pauseMotion:'Pause movement',resumeMotion:'Resume movement'},
  speech:{arrival:'Small ideas. A whole new world.',sorry:'One step at a time. You’ve got this.',listen:'What will you make?',promise:'Your wallet. Your creation.',closer:'Learning is better together.',forgive:'Ready to leave your mark?',space:'Take a breath. Your draft can wait.',ready:'You made something permanent!',kiss:'A little love for your creation.',complete:'Your first step is onchain.',jet:'Watch your idea take flight!',signature:'From zero to onchain.',hello:'Hey, creator! Tap me any time.',sent:'Your creation is on the public wall.',girlTurn:'your idea'} satisfies Record<StoryScene|'hello'|'sent'|'girlTurn',string>,
}
export type SiteCopy=typeof defaultCopy
