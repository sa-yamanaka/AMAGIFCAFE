import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <style jsx global>{`
        html, body {
          margin: 0;
          padding: 0;
          background: #0c0c20;
          color: #fff;
          -webkit-text-size-adjust: 100%;
        }
        * { box-sizing: border-box; }
        button { font: inherit; }
        @keyframes reelSpin {
          0%   { transform: translateY(-8px); }
          50%  { transform: translateY(8px); }
          100% { transform: translateY(-8px); }
        }
      `}</style>
      <Component {...pageProps} />
    </>
  );
}
