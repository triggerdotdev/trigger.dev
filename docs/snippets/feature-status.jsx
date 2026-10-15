export const RollingOut = ({ children }) => (
  <Warning>
    <strong>Rolling out.</strong> This feature is being enabled gradually and may not be available
    for your organization yet.
    {children}
  </Warning>
);

export const PrivateBeta = ({ children }) => (
  <Warning>
    <strong>Private beta.</strong> This feature is only available to some organizations right now.
    {children}
  </Warning>
);
