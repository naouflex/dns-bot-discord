"""DNS resolution functionality for DNS Monitor Bot."""

import asyncio
import aiohttp
import logging
from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime
import json

from .config import get_settings

logger = logging.getLogger(__name__)


class DNSResponse:
    """Represents a DNS query response."""
    
    def __init__(self, status: int, ip_addresses: List[str], ttl: Optional[int] = None,
                 soa_serial: Optional[str] = None, nameserver: Optional[str] = None,
                 admin_email: Optional[str] = None, error: Optional[str] = None):
        self.status = status
        self.ip_addresses = ip_addresses
        self.ttl = ttl
        self.soa_serial = soa_serial
        self.nameserver = nameserver
        self.admin_email = admin_email
        self.error = error
        self.timestamp = datetime.utcnow()
    
    @property
    def is_successful(self) -> bool:
        """Check if the DNS query was successful."""
        return self.status == 0 and not self.error
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary representation."""
        return {
            'status': self.status,
            'ip_addresses': self.ip_addresses,
            'ttl': self.ttl,
            'soa_serial': self.soa_serial,
            'nameserver': self.nameserver,
            'admin_email': self.admin_email,
            'error': self.error,
            'timestamp': self.timestamp.isoformat()
        }


class DNSResolver:
    """Handles DNS resolution using multiple providers."""
    
    def __init__(self):
        self.settings = get_settings()
        self.session: Optional[aiohttp.ClientSession] = None
    
    async def initialize(self):
        """Initialize the HTTP session for DNS queries."""
        timeout = aiohttp.ClientTimeout(total=self.settings.dns_timeout)
        self.session = aiohttp.ClientSession(timeout=timeout)
        logger.info("DNS resolver initialized")
    
    async def close(self):
        """Close the HTTP session."""
        if self.session:
            await self.session.close()
            logger.info("DNS resolver closed")
    
    async def resolve_domain(self, domain: str) -> DNSResponse:
        """
        Resolve a domain using DNS over HTTPS.
        Tries multiple resolvers until one succeeds.
        """
        if not self.session:
            raise RuntimeError("DNS resolver not initialized")
        
        last_error = None
        
        for resolver in self.settings.dns_resolvers_list:
            try:
                response = await self._query_resolver(domain, resolver)
                if response.is_successful:
                    logger.debug(f"Successfully resolved {domain} using {resolver}")
                    return response
                else:
                    logger.warning(f"DNS query failed for {domain} using {resolver}: {response.error}")
                    last_error = response.error
            except Exception as e:
                logger.warning(f"Error querying {resolver} for {domain}: {e}")
                last_error = str(e)
                continue
        
        # All resolvers failed
        logger.error(f"All DNS resolvers failed for {domain}. Last error: {last_error}")
        return DNSResponse(
            status=2,  # SERVFAIL
            ip_addresses=[],
            error=f"All resolvers failed. Last error: {last_error}"
        )
    
    async def _query_resolver(self, domain: str, resolver: str) -> DNSResponse:
        """Query a specific DNS resolver using DNS over HTTPS."""
        # Configure resolver-specific settings
        if resolver == "1.1.1.1":
            url = "https://cloudflare-dns.com/dns-query"
            headers = {
                'Accept': 'application/dns-json',
                'User-Agent': 'DNS-Monitor-Bot/1.0'
            }
            params = {
                'name': domain,
                'type': 'A'
            }
        elif resolver == "8.8.8.8":
            url = "https://dns.google/dns-query"
            headers = {
                'Accept': 'application/dns-json',
                'User-Agent': 'DNS-Monitor-Bot/1.0'
            }
            params = {
                'name': domain,
                'type': 'A'
            }
        elif resolver == "9.9.9.9":
            url = "https://dns.quad9.net/dns-query"
            headers = {
                'Accept': 'application/dns-json',
                'User-Agent': 'DNS-Monitor-Bot/1.0'
            }
            params = {
                'name': domain,
                'type': 'A'
            }
        else:
            # Generic DoH endpoint (may not work for all resolvers)
            url = f"https://{resolver}/dns-query"
            headers = {
                'Accept': 'application/dns-json',
                'User-Agent': 'DNS-Monitor-Bot/1.0'
            }
            params = {
                'name': domain,
                'type': 'A'
            }
        
        try:
            async with self.session.get(url, params=params, headers=headers) as response:
                if response.status != 200:
                    return DNSResponse(
                        status=2,
                        ip_addresses=[],
                        error=f"HTTP {response.status}: {response.reason}"
                    )
                
                # Handle different content types
                content_type = response.headers.get('content-type', '').lower()
                if 'application/dns-json' in content_type or 'application/json' in content_type:
                    try:
                        data = await response.json(content_type=None)  # Allow any content type
                    except Exception as e:
                        # Fallback: try to parse as text then JSON
                        text = await response.text()
                        try:
                            data = json.loads(text)
                        except json.JSONDecodeError:
                            return DNSResponse(
                                status=2,
                                ip_addresses=[],
                                error=f"Failed to parse JSON response: {str(e)}"
                            )
                else:
                    return DNSResponse(
                        status=2,
                        ip_addresses=[],
                        error=f"Unexpected content type: {content_type}"
                    )
                
                return self._parse_dns_response(data, domain)
                
        except asyncio.TimeoutError:
            return DNSResponse(
                status=2,
                ip_addresses=[],
                error="DNS query timeout"
            )
        except aiohttp.ClientError as e:
            return DNSResponse(
                status=2,
                ip_addresses=[],
                error=f"Network error: {str(e)}"
            )
        except json.JSONDecodeError as e:
            return DNSResponse(
                status=2,
                ip_addresses=[],
                error=f"Invalid JSON response: {str(e)}"
            )
    
    def _parse_dns_response(self, data: Dict[str, Any], domain: str) -> DNSResponse:
        """Parse DNS over HTTPS JSON response."""
        try:
            status = data.get('Status', 2)
            
            if status != 0:
                return DNSResponse(
                    status=status,
                    ip_addresses=[],
                    error=f"DNS status code: {status}"
                )
            
            # Extract A records (IPv4 addresses)
            ip_addresses = []
            ttl = None
            
            answers = data.get('Answer', [])
            for answer in answers:
                if answer.get('type') == 1:  # A record
                    ip_addresses.append(answer.get('data'))
                    if ttl is None:
                        ttl = answer.get('TTL')
            
            # Extract SOA information if available
            soa_serial = None
            nameserver = None
            admin_email = None
            
            authority = data.get('Authority', [])
            for auth in authority:
                if auth.get('type') == 6:  # SOA record
                    soa_data = auth.get('data', '')
                    # SOA format: "ns.example.com. admin.example.com. serial refresh retry expire minimum"
                    parts = soa_data.split()
                    if len(parts) >= 3:
                        nameserver = parts[0].rstrip('.')
                        admin_email = parts[1].rstrip('.').replace('.', '@', 1)
                        soa_serial = parts[2]
                    break
            
            return DNSResponse(
                status=status,
                ip_addresses=ip_addresses,
                ttl=ttl,
                soa_serial=soa_serial,
                nameserver=nameserver,
                admin_email=admin_email
            )
            
        except Exception as e:
            logger.error(f"Error parsing DNS response for {domain}: {e}")
            return DNSResponse(
                status=2,
                ip_addresses=[],
                error=f"Response parsing error: {str(e)}"
            )
    
    async def resolve_multiple_domains(self, domains: List[str]) -> Dict[str, DNSResponse]:
        """Resolve multiple domains concurrently."""
        if not domains:
            return {}
        
        logger.info(f"Resolving {len(domains)} domains concurrently")
        
        # Create tasks for concurrent resolution
        tasks = [self.resolve_domain(domain) for domain in domains]
        
        try:
            responses = await asyncio.gather(*tasks, return_exceptions=True)
            
            results = {}
            for domain, response in zip(domains, responses):
                if isinstance(response, Exception):
                    logger.error(f"Exception resolving {domain}: {response}")
                    results[domain] = DNSResponse(
                        status=2,
                        ip_addresses=[],
                        error=f"Exception: {str(response)}"
                    )
                else:
                    results[domain] = response
            
            return results
            
        except Exception as e:
            logger.error(f"Error in concurrent DNS resolution: {e}")
            # Return error responses for all domains
            return {
                domain: DNSResponse(
                    status=2,
                    ip_addresses=[],
                    error=f"Concurrent resolution error: {str(e)}"
                )
                for domain in domains
            }


# Global DNS resolver instance
dns_resolver = DNSResolver()


async def get_dns_resolver() -> DNSResolver:
    """Get the global DNS resolver instance."""
    return dns_resolver
