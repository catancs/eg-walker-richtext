import type { Side } from './index.js'

export interface MarkPolicy {
  /** 'lww': per-position causal last-writer-wins (union emerges for
   *  same-value overlaps). 'multi': all live spans kept (comments). */
  conflict: 'lww' | 'multi'
  /** Side of the END anchor. 'before' (right-sticky) = span grows when
   *  typing at its end (bold). 'after' = does not grow (links, comments). */
  endSide: Side
}

export const MARK_CONFIG: Record<string, MarkPolicy> = {
  bold:      { conflict: 'lww',   endSide: 'before' },
  italic:    { conflict: 'lww',   endSide: 'before' },
  underline: { conflict: 'lww',   endSide: 'before' },
  font:      { conflict: 'lww',   endSide: 'before' },
  color:     { conflict: 'lww',   endSide: 'before' },
  link:      { conflict: 'lww',   endSide: 'after'  },
  comment:   { conflict: 'multi', endSide: 'after'  },
}

export const DEFAULT_POLICY: MarkPolicy = { conflict: 'lww', endSide: 'before' }
export const markPolicy = (t: string): MarkPolicy => MARK_CONFIG[t] ?? DEFAULT_POLICY
