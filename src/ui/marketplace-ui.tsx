import React, { useState } from "react";
import { Text, Box } from "ink";
import { MCPMarketplace } from "../mcp/marketplace.js";

interface MarketplaceResult {
  name: string;
  description: string;
  stars: number;
}

export const MarketplaceUI = () => {
  const [results, setResults] = useState<MarketplaceResult[]>([]);

  const handleSearch = async (query: string) => {
    const marketplace = new MCPMarketplace();
    const searchResults = await marketplace.search(query);
    setResults(searchResults);
  };

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
      <Text color="cyan">MCP Marketplace (Phase 2)</Text>
      <Text color="white">Search and install tools instantly</Text>
      {results.map((r, i) => <Text key={i} color="green">⭐ {r.name} - {r.description}</Text>)}
    </Box>
  );
};
