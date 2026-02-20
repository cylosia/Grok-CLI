import React from 'react';
import { Box } from 'ink';

interface MaxSizedBoxProps {
  maxHeight?: number;
  maxWidth?: number;
  children: React.ReactNode;
}

export const MaxSizedBox: React.FC<MaxSizedBoxProps> = ({
  maxHeight,
  maxWidth,
  children,
  ...props
}) => {
  return (
    <Box 
      flexDirection="column"
      {...(typeof maxHeight === 'number' ? { height: maxHeight } : {})}
      {...(typeof maxWidth === 'number' ? { width: maxWidth } : {})}
      {...props}
    >
      {children}
    </Box>
  );
};