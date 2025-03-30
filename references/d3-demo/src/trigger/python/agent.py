import asyncio
import sys
import os
import json
import requests
from typing import Optional
from pydantic import BaseModel, Field
from agents import Agent, Runner, WebSearchTool, trace
import logfire
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from logfire.propagate import attach_context

logfire.configure(
    service_name='d3-demo',
    send_to_logfire="if-token-present",
    distributed_tracing=True
)
logfire.instrument_openai_agents()

class CSVRowPayload(BaseModel):
    header: str = Field(description="The header of the CSV dataset")
    row: str = Field(description="The row to handle")
    url: str = Field(description="The URL of the CSV dataset")

class WaitToken(BaseModel):
    id: str = Field(description="The wait token ID")
    publicAccessToken: str = Field(description="The public access token for authorization")

class AgentInput(BaseModel):
    row: CSVRowPayload
    waitToken: WaitToken
    jsonSchema: dict
    disableWaitTokenCompletion: bool = Field(default=False, description="Whether to disable wait token completion")
    
class BasicInfo(BaseModel):
    name: str = Field(description="The name of the row")
    email: str = Field(description="The email of the row")
    firstName: Optional[str] = Field(None, description="The first name of the row")
    lastName: Optional[str] = Field(None, description="The last name of the row")
    preferredName: Optional[str] = Field(None, description="The preferred name of the row")

class CompanyInfo(BaseModel):
    name: str = Field(description="The name of the company")
    industry: str = Field(description="The industry of the company")

class SocialInfo(BaseModel):
    twitter: Optional[str] = Field(None, description="The Twitter username of the person")
    linkedin: Optional[str] = Field(None, description="The LinkedIn username of the person")
    facebook: Optional[str] = Field(None, description="The Facebook username of the person")
    instagram: Optional[str] = Field(None, description="The Instagram username of the person")

class RowEnrichmentResult(BaseModel):
    basicInfo: BasicInfo
    companyInfo: CompanyInfo
    socialInfo: SocialInfo

def complete_wait_token(wait_token: WaitToken, result: dict):
    """Send the enrichment result back to Trigger.dev"""
    with trace("complete_wait_token"):
        url = f"{os.environ['TRIGGER_API_URL']}/api/v1/waitpoints/tokens/{wait_token.id}/complete"
        headers = {
            "Authorization": f"Bearer {wait_token.publicAccessToken}",
            "Content-Type": "application/json"
        }
        response = requests.post(url, json={"data": result}, headers=headers)
        response.raise_for_status()
        return response.json()

basic_info_agent = Agent(
    name="Basic Info Agent",
    instructions=f"""You are an expert at extracting basic information from a person's contact details.
    """,
    tools=[WebSearchTool()],
    output_type=BasicInfo
)

company_info_agent = Agent(
    name="Company Info Agent",
    instructions=f"""You are an expert at extracting company information from a person's contact details.
    """,
    tools=[WebSearchTool()],
    output_type=CompanyInfo
)

social_info_agent = Agent(
    name="Social Info Agent",
    instructions=f"""You are an expert at extracting social media information from a person's contact details.
    """,
    tools=[WebSearchTool()],
    output_type=SocialInfo
)

agent = Agent(
    name="CSV Row Enrichment Agent",
    instructions=f"""You are an expert at enriching contact information data.
    Your task is to use web search to find additional information about a person
    based on their basic contact details.

    Please find the basic information, company information, and social media information for the person.

    The input data is from an unspecified CSV dataset, but most likely a CSV dump from a CRM or other source like Mailchimp, etc.

    You'll receive the header row and a single row from the dataset to enrich, in their raw form.
    
    Only include information you are confident about from reliable sources.
    Use null for fields where you cannot find reliable information.
    """,
    tools=[
        basic_info_agent.as_tool(
            tool_name="basic_info_agent", 
            tool_description="Extract basic information from a person's contact details"
        ), 
        company_info_agent.as_tool(
            tool_name="company_info_agent", 
            tool_description="Extract company information from a person's contact details"
        ),
        social_info_agent.as_tool(
            tool_name="social_info_agent", 
            tool_description="Extract social media information from a person's contact details"
        )
    ],
    output_type=RowEnrichmentResult
)

async def main(agent_input: AgentInput):    
    # Run the agent
    result = await Runner.run(
        agent,
        f"""
        Header row: {agent_input.row.header}
        Row to enrich: {agent_input.row.row}
        CSV URL: {agent_input.row.url}
        """
    )

    enriched_data = result.final_output
    if isinstance(enriched_data, BaseModel):
        enriched_data = enriched_data.model_dump()

    print("Final Output:")
    # Pretty print the final output
    print(json.dumps(enriched_data, indent=2))

    if not agent_input.disableWaitTokenCompletion:
        try:        
            # Send the result back to Trigger.dev
            complete_wait_token(agent_input.waitToken, enriched_data)
        
            print("Successfully enriched data and notified Trigger.dev")
        
        except json.JSONDecodeError:  
          print("Error: Agent output was not valid JSON")
          sys.exit(1)
    
    # Make sure to flush the logfire context
    logfire.force_flush()

if __name__ == "__main__":
    # Parse command line input as JSON
    if len(sys.argv) < 2:
        print("Usage: python agent.py '<json_input>'")
        sys.exit(1)

    # Extract the traceparent os.environ['TRACEPARENT']
    carrier ={'traceparent': os.environ['TRACEPARENT']}
    ctx = TraceContextTextMapPropagator().extract(carrier=carrier)
    
    with attach_context(carrier=carrier, third_party=True):
        # Parse the input JSON into our Pydantic model
        input_data = AgentInput.model_validate_json(sys.argv[1])
        asyncio.run(main(input_data))