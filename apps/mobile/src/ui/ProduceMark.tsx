/**
 * Produce marks.
 *
 * Drawn rather than photographed, for a practical reason: a photo of a tomato
 * in a listing implies *that* tomato, and this is a marketplace for Grade B
 * surplus where the whole trust proposition is that the listing does not
 * flatter the goods. A mark identifies the crop at a glance; the supplier's own
 * photographs, taken at the packhouse, carry the truth about condition.
 *
 * They also survive a bad connection in a field, which a photo grid does not.
 */

import React from 'react';
import Svg, { Path, Circle } from 'react-native-svg';

export type CropId = 'tomato' | 'potato' | 'onion' | 'pepper' | 'orange';

export function ProduceMark({ crop, size = 32 }: { crop: CropId; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 32 32' };

  switch (crop) {
    case 'tomato':
      return (
        <Svg {...p}>
          <Path d="M16 8c6 0 10 4.2 10 10s-4.4 9-10 9-10-3.6-10-9S10 8 16 8Z" fill="#C6402F" />
          <Path
            d="M16 8c3.4 0 6.2 1.4 8 3.6-1.6 1-3.6 1.4-5 .6-1.2 2-4.6 2-6 0-1.4.8-3.4.4-5-.6C9.8 9.4 12.6 8 16 8Z"
            fill="#D95845"
            opacity={0.26}
          />
          <Path d="M16 9V6" stroke="#4A7A2E" strokeWidth={1.8} strokeLinecap="round" />
          <Path
            d="M16 8c-1.6-2.4-4-3-6-2.4 1 2.2 3 3.4 6 2.4Zm0 0c1.6-2.4 4-3 6-2.4-1 2.2-3 3.4-6 2.4Z"
            fill="#5C9138"
          />
        </Svg>
      );

    case 'potato':
      return (
        <Svg {...p}>
          <Path d="M8.5 13c1.5-5 7-8 12-6.2S28 14 25.5 20s-8.5 8-13.5 5.4S7 18 8.5 13Z" fill="#C79A5E" />
          <Circle cx={13} cy={14} r={1.3} fill="#9C7440" />
          <Circle cx={19} cy={12} r={1} fill="#9C7440" />
          <Circle cx={17} cy={20} r={1.2} fill="#9C7440" />
          <Circle cx={22} cy={18} r={0.9} fill="#9C7440" />
        </Svg>
      );

    case 'onion':
      return (
        <Svg {...p}>
          <Path d="M16 8c5.5 0 9.5 4.5 9.5 10S21.5 27 16 27 6.5 23.5 6.5 18 10.5 8 16 8Z" fill="#A8506B" />
          <Path d="M16 8c2.2 0 3.8 4.5 3.8 10S18.2 27 16 27s-3.8-3.5-3.8-9S13.8 8 16 8Z" fill="#C4738C" opacity={0.38} />
          <Path d="M16 8l-2-3.5M16 8l2-3.5M16 8V4" stroke="#7E9455" strokeWidth={1.6} strokeLinecap="round" />
        </Svg>
      );

    case 'pepper':
      return (
        <Svg {...p}>
          <Path d="M10 14c0-3.8 2.8-6 6-6s6 2.2 6 6v5c0 4.5-2.6 7-6 7s-6-2.5-6-7Z" fill="#D9A21C" />
          <Path d="M16 8c3.2 0 6 2.2 6 6v5c0 4.5-2.6 7-6 7Z" fill="#000000" opacity={0.07} />
          <Path d="M16 8V5.5" stroke="#4A7A2E" strokeWidth={1.8} strokeLinecap="round" />
          <Path d="M12.5 6.5c2-1 5-1 7 0-1.2 1.6-5.8 1.6-7 0Z" fill="#5C9138" />
        </Svg>
      );

    case 'orange':
      return (
        <Svg {...p}>
          <Circle cx={16} cy={18} r={9.5} fill="#DF8420" />
          <Circle cx={12.5} cy={14.5} r={2.6} fill="#EDA550" opacity={0.25} />
          <Path d="M16 8.5V6" stroke="#4A7A2E" strokeWidth={1.8} strokeLinecap="round" />
          <Path d="M16.5 6.5c1.8-1.6 4.4-1.6 5.6-.4-.8 2-4 2.6-5.6.4Z" fill="#5C9138" />
        </Svg>
      );
  }
}
