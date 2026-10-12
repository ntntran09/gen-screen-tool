"""API request/response models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

NODE_TYPES = ("prompt", "image", "original", "theme", "palette", "collection", "generate", "output")


class Viewport(BaseModel):
    x: float = 0
    y: float = 0
    zoom: float = 1


class GraphNode(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    type: str
    position: dict[str, float]
    width: float | None = None
    height: float | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    source: str
    sourceHandle: str | None = None
    target: str
    targetHandle: str | None = None


class Graph(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    viewport: Viewport = Field(default_factory=Viewport)


class ProjectCreate(BaseModel):
    name: str = Field(default="Untitled Project", min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    graph: Graph | None = None


class ProjectSummary(BaseModel):
    id: str
    name: str
    description: str
    created_at: str
    updated_at: str


class ProjectDetail(ProjectSummary):
    graph: Graph
