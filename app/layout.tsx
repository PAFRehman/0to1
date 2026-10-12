import type {Metadata,Viewport} from 'next'
import './studio.css'
export const metadata:Metadata={title:'PenguMint · From zero to onchain',description:'A student creation studio on Base Sepolia. Create a wallet, mint artwork, notes or a creative signature, and explore the live public wall.',applicationName:'PenguMint',referrer:'no-referrer',icons:{icon:'/icon.svg'},openGraph:{title:'PenguMint',description:'Make your first onchain creation with Pip, your penguin guide.',type:'website'},twitter:{card:'summary',title:'PenguMint',description:'A student-friendly onchain creation studio.'}}
export const viewport:Viewport={themeColor:'#143d50',colorScheme:'light',width:'device-width',initialScale:1}
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
