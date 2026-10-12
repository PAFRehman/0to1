import {defineChain} from 'viem'

export const baseSepolia=defineChain({
  id:84532,
  name:'Base Sepolia',
  nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
  rpcUrls:{default:{http:['https://sepolia.base.org']}},
  blockExplorers:{default:{name:'BaseScan',url:'https://sepolia.basescan.org'}},
  testnet:true,
})
